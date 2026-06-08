# Dev-Agent Scale-to-Zero (event-driven wake/sleep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the always-on `dev-agent` VM sleep when idle and wake on relevant Slack events, dropping idle cost from ~$49/mo to ~$5–10/mo.

**Architecture:** Move the Slack app off Socket Mode (persistent WebSocket → forces VM always-on) onto the **Events API** (HTTP push). A scale-to-zero **Cloud Function (gen2) "front door"** is the only public surface: it verifies Slack's signature, answers the `url_verification` challenge, filters to relevant events, publishes the raw event to a **PubSub** topic, and **starts the VM** — all within Slack's 3s ack window. On the VM, a **replay service** drains PubSub and re-injects each event into the agent's existing local webhook listener (re-signing with a fresh timestamp so the adapter's signature/timestamp check passes). An **idle watchdog** stops the VM when no agent containers are running and no event has arrived for N minutes. `startup.sh` gets a **fast-boot guard** so a wake-boot does NOT re-run the multi-minute `pnpm install` + `tsc` + Docker image rebuild.

**Tech Stack:** GCE (existing `dev-agent` VM, `vatedge-prod`, `europe-west1-b`), Cloud Functions gen2 (Node 20), Cloud Pub/Sub, systemd, the agent's existing `@chat-adapter/slack` webhook transport (`src/webhook-server.ts`, route `/webhook/slack`, env `WEBHOOK_PORT`).

---

## ⚠️ Reality check — read before executing

- **Marginal saving is ~$40/mo** over the *already-done* rightsize (e2-standard-2 ≈ $49/mo). This plan adds: a public HTTPS endpoint (new attack surface), a PubSub topic, a Cloud Function, two systemd units, and a `startup.sh` change. Worth it if you value scale-to-zero on principle or expect the fleet to grow; if pure ROI, the simpler **scheduled on/off** (GCE instance schedule, work-hours only, zero code, no public surface) captures ~$30/mo of that with a fraction of the moving parts.
- **One step cannot be done with gcloud:** reconfiguring the Slack app (disable Socket Mode, enable Events API, set the Request URL). That is done in `api.slack.com/apps` (or via the `apps.manifest.update` API with an app-config token) by someone with admin on the Slack app — **Task 7**, your action.
- **Latency trade:** first event after the VM has slept incurs a **~60–90s cold boot** before the agent reacts (vs instant today). Acceptable for deploy-failure triage; confirm it's acceptable for any DM use.

## Decisions (defaults chosen — override before executing if desired)

- **IDLE_MINUTES = 15** — how long with no containers + no events before self-stop. Lower = cheaper + more cold-boots; higher = warmer + costlier.
- **Front door = Cloud Functions gen2** (least infra vs Cloud Run). Region `europe-west1`.
- **WEBHOOK_PORT = 8420** — pinned explicitly in the service env so every component agrees.
- **Wake filter:** wake on every Slack `event_callback` except messages authored by the bot itself (`subtype=bot_message` / `bot_id` present). Slack only sends subscribed event types, so the firehose is already scoped at the app level.

## Fixed facts (do not re-derive)

- Instance: `dev-agent`, zone `europe-west1-b`, project `vatedge-prod`.
- VM service account (ADC on the box): `dev-agent@vatedge-prod.iam.gserviceaccount.com`.
- Secrets in Secret Manager: `dev-agent-slack_signing_secret` (verify exact name in Task 1), and the app token secret that holds `xapp-…` (drives Socket Mode). Removing/blanking the app token flips `src/channels/slack.ts` to the webhook adapter.
- State survives stop/start: both the **boot disk** (`/opt/vatedge-dev-agent`, `dist/`, `node_modules`) and the **data disk** (`/mnt/dev-agent-data`: docker images, sessions, DBs) persist. Only a fresh reprovision (new boot disk) loses them.

---

## Task 1: Confirm secret names, port, and current Slack transport

**Files:** none (investigation; pure reads).

- [ ] **Step 1: List the Slack-related secrets**

Run:
```bash
gcloud secrets list --project=vatedge-prod --filter="name~slack OR name~SLACK" --format="value(name)"
```
Expected: a signing-secret entry and an app-token entry. Record both exact names. Referenced below as `<SIGNING_SECRET_NAME>` and `<APP_TOKEN_SECRET_NAME>`.

- [ ] **Step 2: Confirm the agent's secret-key wiring**

Run:
```bash
grep -nE "SLACK_(APP_TOKEN|SIGNING_SECRET)" /Users/rotemassa/WebstormProjects/vatedge-workspace/vatedge-dev-agent/src/secrets/scoped-secrets.ts
```
Expected: both keys present in the GCP and container key arrays. Confirms blanking the app token switches transports.

- [ ] **Step 3: Confirm the webhook route + port env**

Run:
```bash
grep -nE "WEBHOOK_PORT|/webhook/|DEFAULT_PORT" /Users/rotemassa/WebstormProjects/vatedge-workspace/vatedge-dev-agent/src/webhook-server.ts
```
Expected: `WEBHOOK_PORT` env read; route `/webhook/{adapterName}`. The Slack adapter registers as `slack` → endpoint `http://127.0.0.1:8420/webhook/slack`.

---

## Task 2: Provision PubSub (wake topic + pull subscription)

**Files:** none (gcloud).

- [ ] **Step 1: Create the topic**

Run:
```bash
gcloud pubsub topics create dev-agent-wake --project=vatedge-prod
```
Expected: `Created topic [projects/vatedge-prod/topics/dev-agent-wake].`

- [ ] **Step 2: Create the pull subscription (short retention; events are only useful briefly)**

Run:
```bash
gcloud pubsub subscriptions create dev-agent-wake-sub \
  --project=vatedge-prod --topic=dev-agent-wake \
  --ack-deadline=30 --message-retention-duration=1h --expiration-period=never
```
Expected: `Created subscription [...dev-agent-wake-sub].`

- [ ] **Step 3: Grant the VM SA subscribe rights**

Run:
```bash
gcloud pubsub subscriptions add-iam-policy-binding dev-agent-wake-sub \
  --project=vatedge-prod \
  --member="serviceAccount:dev-agent@vatedge-prod.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"
```
Expected: an updated IAM policy printed.

---

## Task 3: IAM — front-door SA (start VM + publish) and VM self-stop

**Files:** none (gcloud).

- [ ] **Step 1: Create the front-door service account**

Run:
```bash
gcloud iam service-accounts create dev-agent-frontdoor \
  --project=vatedge-prod --display-name="dev-agent wake front door"
```
Expected: created.

- [ ] **Step 2: Allow it to publish to the wake topic**

Run:
```bash
gcloud pubsub topics add-iam-policy-binding dev-agent-wake \
  --project=vatedge-prod \
  --member="serviceAccount:dev-agent-frontdoor@vatedge-prod.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```
Expected: updated policy.

- [ ] **Step 3: Custom role with exactly start+stop, then bind front-door (start) and VM SA (stop) at instance scope**

Run:
```bash
gcloud iam roles create devAgentPowerToggle --project=vatedge-prod \
  --title="Dev-Agent power toggle" \
  --permissions=compute.instances.start,compute.instances.stop,compute.instances.get \
  --stage=GA
```
Then bind both SAs on the instance resource:
```bash
gcloud compute instances add-iam-policy-binding dev-agent \
  --zone=europe-west1-b --project=vatedge-prod \
  --member="serviceAccount:dev-agent-frontdoor@vatedge-prod.iam.gserviceaccount.com" \
  --role="projects/vatedge-prod/roles/devAgentPowerToggle"

gcloud compute instances add-iam-policy-binding dev-agent \
  --zone=europe-west1-b --project=vatedge-prod \
  --member="serviceAccount:dev-agent@vatedge-prod.iam.gserviceaccount.com" \
  --role="projects/vatedge-prod/roles/devAgentPowerToggle"
```
Expected: each prints an updated IAM policy. (Instance-level IAM is supported for `compute.instances.start/stop`.)

---

## Task 4: The front door (Cloud Function gen2)

**Files:**
- Create: `vatedge-dev-agent/deploy/wake/frontdoor/index.mjs`
- Create: `vatedge-dev-agent/deploy/wake/frontdoor/package.json`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "dev-agent-frontdoor",
  "version": "1.0.0",
  "type": "module",
  "main": "index.mjs",
  "dependencies": {
    "@google-cloud/pubsub": "^4.9.0",
    "@google-cloud/compute": "^4.8.0"
  }
}
```

- [ ] **Step 2: Write `index.mjs`** (verify Slack signature; answer `url_verification`; filter; publish; start VM; ack within 3s)

```javascript
import crypto from 'node:crypto';
import { PubSub } from '@google-cloud/pubsub';
import compute from '@google-cloud/compute';

const PROJECT = 'vatedge-prod';
const ZONE = 'europe-west1-b';
const INSTANCE = 'dev-agent';
const TOPIC = 'dev-agent-wake';
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET; // injected from Secret Manager at deploy

const pubsub = new PubSub({ projectId: PROJECT });
const instances = new compute.InstancesClient();

function verifySlack(req, rawBody) {
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  // Reject events older than 5 minutes (Slack replay-protection window).
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${rawBody}`;
  const mine = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
  } catch {
    return false;
  }
}

async function startVm() {
  // Idempotent: starting a RUNNING/STAGING instance is a no-op that resolves fine.
  try {
    await instances.start({ project: PROJECT, zone: ZONE, instance: INSTANCE });
  } catch (err) {
    // Swallow "already running" / transient races — the PubSub msg is retained regardless.
    console.warn('startVm warning:', err?.message || err);
  }
}

// Cloud Functions gen2 (HTTP). rawBody is provided by the functions framework.
export const slackWake = async (req, res) => {
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});

  if (!verifySlack(req, rawBody)) {
    res.status(401).send('bad signature');
    return;
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { body = {}; }

  // Slack URL ownership challenge (sent when you save the Request URL).
  if (body.type === 'url_verification') {
    res.status(200).set('Content-Type', 'text/plain').send(body.challenge);
    return;
  }

  // Filter: only event_callbacks, and never the bot's own messages.
  const ev = body.event || {};
  const isBotEcho = ev.subtype === 'bot_message' || !!ev.bot_id;
  const relevant = body.type === 'event_callback' && !isBotEcho;

  if (relevant) {
    // Preserve the headers the replay step needs to reconstruct a valid request.
    const attributes = {
      slackRetryNum: String(req.headers['x-slack-retry-num'] || ''),
      eventId: String(body.event_id || ''),
    };
    await Promise.all([
      pubsub.topic(TOPIC).publishMessage({ data: Buffer.from(rawBody), attributes }),
      startVm(),
    ]);
  }

  // Always 200 fast so Slack doesn't retry/disable the endpoint.
  res.status(200).send('ok');
};
```

- [ ] **Step 3: Deploy the function with the signing secret injected**

Run (uses `<SIGNING_SECRET_NAME>` from Task 1):
```bash
cd /Users/rotemassa/WebstormProjects/vatedge-workspace/vatedge-dev-agent/deploy/wake/frontdoor
gcloud functions deploy dev-agent-frontdoor \
  --gen2 --runtime=nodejs20 --region=europe-west1 --project=vatedge-prod \
  --source=. --entry-point=slackWake --trigger-http --allow-unauthenticated \
  --service-account=dev-agent-frontdoor@vatedge-prod.iam.gserviceaccount.com \
  --set-secrets="SLACK_SIGNING_SECRET=<SIGNING_SECRET_NAME>:latest" \
  --memory=256Mi --timeout=10s --max-instances=3
```
Expected: deploy succeeds and prints a `url:` like `https://europe-west1-vatedge-prod.cloudfunctions.net/dev-agent-frontdoor`. Record it as `<FRONTDOOR_URL>`. (`--allow-unauthenticated` is required because Slack calls it unauthenticated; the Slack signature check is the auth.)

- [ ] **Step 4: Smoke-test the challenge path**

Run (computes a valid signature for a fake challenge — replace `SECRET` with the signing secret value for the test only; do not commit it):
```bash
TS=$(date +%s); BODY='{"type":"url_verification","challenge":"abc123"}'
SIG="v0=$(printf "v0:%s:%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "SECRET" | awk '{print $2}')"
curl -s -X POST <FRONTDOOR_URL> -H "x-slack-request-timestamp: $TS" \
  -H "x-slack-signature: $SIG" -H 'Content-Type: application/json' -d "$BODY"
```
Expected: prints `abc123`. A wrong/blank signature returns `bad signature` (401).

---

## Task 5: The replay service on the VM

**Files:**
- Create: `vatedge-dev-agent/deploy/wake/replay.mjs`
- Create: `vatedge-dev-agent/deploy/wake/dev-agent-replay.service`

- [ ] **Step 1: Write `replay.mjs`** (pull from PubSub → re-sign with fresh timestamp → POST to local webhook → touch activity file → ack)

```javascript
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PubSub } from '@google-cloud/pubsub';

const PROJECT = 'vatedge-prod';
const SUBSCRIPTION = 'dev-agent-wake-sub';
const PORT = process.env.WEBHOOK_PORT || '8420';
const ENDPOINT = `http://127.0.0.1:${PORT}/webhook/slack`;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ACTIVITY_FILE = '/run/dev-agent-last-activity';

function touchActivity() {
  try { fs.writeFileSync(ACTIVITY_FILE, String(Date.now())); } catch (e) { console.warn('touch failed', e); }
}

async function deliver(rawBody) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${ts}:${rawBody}`).digest('hex');
  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body: rawBody,
  });
  if (!resp.ok) throw new Error(`webhook ${resp.status}`);
}

touchActivity(); // fresh boot starts the idle clock

const sub = new PubSub({ projectId: PROJECT }).subscription(SUBSCRIPTION, {
  flowControl: { maxMessages: 5 },
});

sub.on('message', async (msg) => {
  const rawBody = msg.data.toString('utf8');
  touchActivity();
  try {
    await deliver(rawBody);
    msg.ack();
  } catch (err) {
    console.error('replay failed, will redeliver:', err?.message || err);
    msg.nack(); // webhook not up yet → redeliver shortly
  }
});

sub.on('error', (err) => console.error('subscription error:', err?.message || err));
console.log('dev-agent-replay listening on', SUBSCRIPTION, '→', ENDPOINT);
```

- [ ] **Step 2: Write the systemd unit `dev-agent-replay.service`**

```ini
[Unit]
Description=Dev-Agent Slack event replay (PubSub -> local webhook)
After=dev-agent.service network-online.target
Wants=dev-agent.service

[Service]
Type=simple
User=devagent
WorkingDirectory=/opt/vatedge-dev-agent/deploy/wake
# WEBHOOK_PORT must match dev-agent.service; SLACK_SIGNING_SECRET is fetched at ExecStartPre.
Environment=WEBHOOK_PORT=8420
ExecStartPre=/bin/bash -c 'gcloud secrets versions access latest --secret=<SIGNING_SECRET_NAME> --project=vatedge-prod > /run/dev-agent-signing-secret && chmod 600 /run/dev-agent-signing-secret'
ExecStart=/bin/bash -c 'SLACK_SIGNING_SECRET="$(cat /run/dev-agent-signing-secret)" exec node /opt/vatedge-dev-agent/deploy/wake/replay.mjs'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Add `@google-cloud/pubsub` to the host deps if absent**

Run:
```bash
cd /Users/rotemassa/WebstormProjects/vatedge-workspace/vatedge-dev-agent
grep -q '"@google-cloud/pubsub"' package.json && echo "already present" || pnpm add @google-cloud/pubsub
```
Expected: `already present` (the backend uses PubSub; the dev-agent may already have it) or a lockfile update. If added, this ships to the VM via `deploy.sh`.

---

## Task 6: The idle watchdog (self-stop) on the VM

**Files:**
- Create: `vatedge-dev-agent/deploy/wake/idle-stop.sh`
- Create: `vatedge-dev-agent/deploy/wake/dev-agent-idle.service`
- Create: `vatedge-dev-agent/deploy/wake/dev-agent-idle.timer`

- [ ] **Step 1: Write `idle-stop.sh`** (stop only when no agent containers AND no event for IDLE_MINUTES)

```bash
#!/usr/bin/env bash
set -euo pipefail
IDLE_MINUTES="${IDLE_MINUTES:-15}"
ACTIVITY_FILE="/run/dev-agent-last-activity"
INSTANCE="dev-agent"
ZONE="europe-west1-b"
PROJECT="vatedge-prod"

# 1. If any agent container is running, the agent is working — never stop.
running="$(docker ps -q --filter 'label=nanoclaw-install' | wc -l | tr -d ' ')"
if [ "${running}" != "0" ]; then
  date +%s > "${ACTIVITY_FILE}"   # treat active work as activity
  echo "busy: ${running} container(s) — staying up"
  exit 0
fi

# 2. Respect the idle window since the last wake event / boot.
now="$(date +%s)"
last="$( [ -f "${ACTIVITY_FILE}" ] && cat "${ACTIVITY_FILE}" || echo 0 )"
# last is stored as ms by replay.mjs; normalize if it looks like ms.
[ "${#last}" -ge 13 ] && last=$(( last / 1000 ))
idle=$(( now - last ))
if [ "${idle}" -lt $(( IDLE_MINUTES * 60 )) ]; then
  echo "idle ${idle}s < ${IDLE_MINUTES}m — staying up"
  exit 0
fi

echo "idle ${idle}s >= ${IDLE_MINUTES}m and no containers — stopping ${INSTANCE}"
gcloud compute instances stop "${INSTANCE}" --zone="${ZONE}" --project="${PROJECT}" --quiet
```

- [ ] **Step 2: Write `dev-agent-idle.service`**

```ini
[Unit]
Description=Dev-Agent idle watchdog (self-stop when idle)

[Service]
Type=oneshot
User=devagent
Environment=IDLE_MINUTES=15
ExecStart=/opt/vatedge-dev-agent/deploy/wake/idle-stop.sh
```

- [ ] **Step 3: Write `dev-agent-idle.timer`**

```ini
[Unit]
Description=Run the dev-agent idle watchdog every minute

[Timer]
OnBootSec=5min
OnUnitActiveSec=1min
AccuracySec=15s

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Make the script executable**

Run:
```bash
chmod +x /Users/rotemassa/WebstormProjects/vatedge-workspace/vatedge-dev-agent/deploy/wake/idle-stop.sh
```
Expected: no output.

---

## Task 7: Reconfigure the Slack app (manual — your action)

**Files:** none (Slack admin console).

- [ ] **Step 1: Disable Socket Mode** in `api.slack.com/apps` → your app → **Socket Mode** → toggle off.

- [ ] **Step 2: Enable Events API** → **Event Subscriptions** → toggle on → set **Request URL** to `<FRONTDOOR_URL>`. Slack POSTs the `url_verification` challenge; the front door (Task 4) echoes it → URL shows **Verified**.

- [ ] **Step 3: Subscribe to bot events** (matches current behavior): `app_mention`, `message.im`, and `message.channels` (the last is what lets the `dev-deploy-alert` skill see un-mentioned `#deploys` messages). Reinstall the app if Slack prompts for new scopes.

- [ ] **Step 4: Remove the app token so the agent uses the webhook transport.** Either delete `<APP_TOKEN_SECRET_NAME>` or set it to empty so `src/channels/slack.ts` falls through to the webhook adapter:
```bash
printf '' | gcloud secrets versions add <APP_TOKEN_SECRET_NAME> --project=vatedge-prod --data-file=-
```
Expected: a new (empty) secret version. (`scoped-secrets.ts` already tolerates an empty app token.)

---

## Task 8: Wire it onto the VM (env, fast-boot guard, enable units)

**Files:**
- Modify: `vatedge-dev-agent/deploy/dev-agent.service` (add `WEBHOOK_PORT`)
- Modify: `vatedge-dev-agent/deploy/startup.sh` (fast-boot guard + install/enable new units)

- [ ] **Step 1: Pin `WEBHOOK_PORT` in `dev-agent.service`**

Add under the existing `Environment=` block:
```ini
Environment=WEBHOOK_PORT=8420
```

- [ ] **Step 2: Add the fast-boot guard around `deploy.sh` in `startup.sh`**

Replace the section-6 invocation:
```bash
# ── 6. Build + deploy (as devagent) ───────────────────────────────────────────
log "Running deploy.sh as ${RUN_USER}"
sudo -u "${RUN_USER}" REPO_BRANCH="${REPO_BRANCH}" bash "${INSTALL_DIR}/deploy/deploy.sh" --skip-restart
```
with:
```bash
# ── 6. Build + deploy (as devagent) — first provision only ────────────────────
# A wake-boot must NOT re-run pnpm install + tsc + the Docker image rebuild
# (minutes). Those persist on the boot+data disks across stop/start, and code
# updates arrive via the push-to-deploy pipeline (SSH + deploy.sh), not via boot.
if [ ! -f "${INSTALL_DIR}/.provisioned" ]; then
  log "First provision — running deploy.sh"
  sudo -u "${RUN_USER}" REPO_BRANCH="${REPO_BRANCH}" bash "${INSTALL_DIR}/deploy/deploy.sh" --skip-restart
  sudo -u "${RUN_USER}" touch "${INSTALL_DIR}/.provisioned"
else
  log "Already provisioned — skipping rebuild (fast wake-boot)"
fi
```

- [ ] **Step 3: Install + enable the new units in `startup.sh` section 7**

Append after the existing `dev-agent.service` install block:
```bash
log "Installing wake/replay + idle-watchdog units"
install -m 0644 "${INSTALL_DIR}/deploy/wake/dev-agent-replay.service" /etc/systemd/system/dev-agent-replay.service
install -m 0644 "${INSTALL_DIR}/deploy/wake/dev-agent-idle.service"   /etc/systemd/system/dev-agent-idle.service
install -m 0644 "${INSTALL_DIR}/deploy/wake/dev-agent-idle.timer"     /etc/systemd/system/dev-agent-idle.timer
systemctl daemon-reload
systemctl enable --now dev-agent-replay.service
systemctl enable --now dev-agent-idle.timer
```

- [ ] **Step 4: Push startup.sh changes into instance metadata** (repo edit alone does NOT touch the running VM — known gotcha)

Run:
```bash
gcloud compute instances add-metadata dev-agent --zone=europe-west1-b --project=vatedge-prod \
  --metadata-from-file=startup-script=/Users/rotemassa/WebstormProjects/vatedge-workspace/vatedge-dev-agent/deploy/startup.sh
```
Expected: `Updated [...dev-agent].`

- [ ] **Step 5: Deploy the new code/units to the live box without rebooting** (the box is already running)

Run:
```bash
gcloud compute ssh dev-agent --zone=europe-west1-b --project=vatedge-prod --command '
  set -e
  cd /opt/vatedge-dev-agent && git pull --ff-only
  touch /opt/vatedge-dev-agent/.provisioned
  sudo install -m 0644 deploy/dev-agent.service /etc/systemd/system/dev-agent.service
  sudo install -m 0644 deploy/wake/dev-agent-replay.service /etc/systemd/system/dev-agent-replay.service
  sudo install -m 0644 deploy/wake/dev-agent-idle.service /etc/systemd/system/dev-agent-idle.service
  sudo install -m 0644 deploy/wake/dev-agent-idle.timer /etc/systemd/system/dev-agent-idle.timer
  sudo systemctl daemon-reload
  sudo systemctl restart dev-agent
  sudo systemctl enable --now dev-agent-replay.service
  sudo systemctl enable --now dev-agent-idle.timer
  systemctl is-active dev-agent dev-agent-replay; systemctl is-active dev-agent-idle.timer'
```
Expected: `active` for `dev-agent`, `dev-agent-replay`, and the timer. (This step assumes the branch with these files is merged/pulled — sequence with your normal deploy flow; do not `git pull` over uncommitted work.)

---

## Task 9: End-to-end verification

**Files:** none.

- [ ] **Step 1: Confirm the agent is in webhook mode (not Socket Mode)**

Run:
```bash
gcloud compute ssh dev-agent --zone=europe-west1-b --project=vatedge-prod --command \
  'sudo journalctl -u dev-agent --no-pager | grep -iE "Webhook server started|Socket Mode" | tail -3'
```
Expected: `Webhook server started ... port: 8420` and **no** "Socket Mode listener started".

- [ ] **Step 2: Live wake test (cold path)** — stop the VM, then post in Slack and watch it come back.

Run:
```bash
gcloud compute instances stop dev-agent --zone=europe-west1-b --project=vatedge-prod
```
Then `@`-mention the bot in a wired Slack channel. Within ~30s the instance should flip to STARTING:
```bash
gcloud compute instances describe dev-agent --zone=europe-west1-b --project=vatedge-prod --format='value(status)'
```
Expected: `STAGING`/`RUNNING`. The buffered event sits in `dev-agent-wake-sub` until the replay service drains it on boot; the agent then responds in-thread (~60–90s total).

- [ ] **Step 3: Confirm replay delivered the buffered event**

Run:
```bash
gcloud compute ssh dev-agent --zone=europe-west1-b --project=vatedge-prod --command \
  'sudo journalctl -u dev-agent-replay --no-pager | tail -10'
```
Expected: `dev-agent-replay listening ...` then no `replay failed` errors for the test event.

- [ ] **Step 4: Confirm idle self-stop**

Leave the agent untouched (no containers running). After `IDLE_MINUTES`+1:
```bash
gcloud compute instances describe dev-agent --zone=europe-west1-b --project=vatedge-prod --format='value(status)'
```
Expected: `TERMINATED`. Check the reasoning:
```bash
gcloud compute ssh dev-agent --zone=europe-west1-b --project=vatedge-prod --command \
  'journalctl -u dev-agent-idle --no-pager | tail -5' 2>/dev/null || echo "VM already stopped (expected)"
```

- [ ] **Step 5: Confirm cost posture**

Check that the front door + PubSub are scale-to-zero (no min instances, no always-on subscriber cost): they bill per request only. Note the VM now spends most off-hours `TERMINATED`.

---

## Known edges / accepted limitations

- **Start-during-STOPPING race:** if an event lands in the few seconds the VM is shutting down, `instances.start` may transiently fail. The PubSub message is retained (1h), and the next Slack retry / a later event re-issues start. Worst case: one extra cold boot or a ~1-min delay. Not data loss.
- **Duplicate delivery:** Slack retries + PubSub at-least-once can deliver an event twice. The agent already de-dupes inbound by message ts/thread; `event_id` is carried as a PubSub attribute if stronger de-dup is ever needed.
- **First boot after a real code deploy** still runs the full `deploy.sh` via the push-to-deploy SSH path (unchanged) — the fast-boot guard only skips the rebuild on *wake* boots, not on deploys.
- **DM latency:** any human DM to the agent now incurs cold-boot latency when it's asleep. If that's unacceptable, scope DMs to keep-warm hours via a parallel instance schedule.

## Self-review notes

- Spec coverage: move-off-Socket-Mode (T7), public front door (T4), buffering (T2/T5), wake (T3/T4), drain+re-sign (T5), sleep (T6), fast-boot (T8) — all covered.
- Port/route/secret names are pinned to real values (`WEBHOOK_PORT=8420`, `/webhook/slack`, `<SIGNING_SECRET_NAME>` resolved in T1).
- IAM least-privilege via a custom 2-permission role bound at instance scope, not project Owner.
