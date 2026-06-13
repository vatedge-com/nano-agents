/**
 * slack-gateway — the always-on, scale-to-zero front for the wake-on-message
 * dev-agent VM.
 *
 * Slack (Events API) POSTs here. This function:
 *   1. Verifies the Slack HMAC signature + timestamp freshness (authoritative
 *      auth — the VM trusts Pub/Sub provenance, not a re-checked stale ts).
 *   2. Answers the one-time url_verification challenge.
 *   3. Publishes the event to Pub/Sub (durable buffer) tagged with slack_type.
 *   4. Starts the dev-agent VM if it is stopped (it pulls the backlog on boot).
 *   5. ACKs 200 well inside Slack's 3s window.
 *
 * It holds ONLY the Slack signing secret — never the bot token or repo creds.
 * Worst case if compromised: start the VM + publish a Slack-shaped event.
 *
 * Env:
 *   SLACK_SIGNING_SECRET  Slack app signing secret (inject via --set-secrets)
 *   PUBSUB_TOPIC          topic id, e.g. "dev-agent-slack-events"
 *   VM_PROJECT            GCP project of the VM, e.g. "vatedge-prod"
 *   VM_ZONE               e.g. "europe-west1-b"
 *   VM_NAME               instance name
 */
const crypto = require('crypto');

const { PubSub } = require('@google-cloud/pubsub');
const { InstancesClient } = require('@google-cloud/compute').v1;

const pubsub = new PubSub();
const instances = new InstancesClient();

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const TOPIC = process.env.PUBSUB_TOPIC || 'dev-agent-slack-events';
const VM_PROJECT = process.env.VM_PROJECT || '';
const VM_ZONE = process.env.VM_ZONE || '';
const VM_NAME = process.env.VM_NAME || '';

const REPLAY_WINDOW_S = 300;
// States from which a start makes sense / is safe to issue.
const WAKEABLE = new Set(['TERMINATED', 'STOPPED', 'STOPPING', 'SUSPENDED', 'SUSPENDING']);

function verifySlack(req) {
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > REPLAY_WINDOW_S) return false;
  const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || '');
  const expected = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Map the request to { slackType, data } mirroring the VM-side reconstruction. */
function classify(req) {
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (contentType.includes('application/json')) {
    return { slackType: 'events_api', data: raw };
  }
  // form-urlencoded: interactive payloads arrive under `payload=`, slash
  // commands as flat params.
  const params = new URLSearchParams(raw);
  const payload = params.get('payload');
  if (payload) return { slackType: 'interactive', data: payload };
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return { slackType: 'slash_commands', data: JSON.stringify(obj) };
}

async function wakeVm() {
  if (!VM_PROJECT || !VM_ZONE || !VM_NAME) return;
  const [vm] = await instances.get({ project: VM_PROJECT, zone: VM_ZONE, instance: VM_NAME });
  if (WAKEABLE.has(vm.status)) {
    await instances.start({ project: VM_PROJECT, zone: VM_ZONE, instance: VM_NAME });
    console.log(`slack-gateway: started VM ${VM_NAME} (was ${vm.status})`);
  }
}

exports.slackGateway = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }
  if (!verifySlack(req)) {
    res.status(401).send('bad signature');
    return;
  }

  // url_verification challenge (sent as JSON during endpoint setup).
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (ct.includes('application/json')) {
    let body = req.body;
    if (!body && req.rawBody) {
      try {
        body = JSON.parse(req.rawBody.toString('utf8'));
      } catch {
        body = null;
      }
    }
    if (body && body.type === 'url_verification') {
      res.status(200).json({ challenge: body.challenge });
      return;
    }
  }

  const { slackType, data } = classify(req);
  try {
    await pubsub.topic(TOPIC).publishMessage({ data: Buffer.from(data, 'utf8'), attributes: { slack_type: slackType } });
    await wakeVm();
  } catch (err) {
    // We've authenticated the event; log and still 200 so Slack doesn't retry
    // a delivery we may have partially handled. (Pub/Sub publish failures are
    // rare; a retry storm is worse than a single dropped event here.)
    console.error('slack-gateway: publish/wake failed', err);
  }
  res.status(200).send('ok');
};
