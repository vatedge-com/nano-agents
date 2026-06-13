/**
 * Slack Pub/Sub adapter — inbound transport for the wake-on-message model.
 *
 * Sibling of `slack-socket-mode.ts`. Same idea, different transport: instead of
 * an outbound WebSocket (Socket Mode) or an inbound HTTP webhook (Events API),
 * inbound Slack events arrive via a **Pub/Sub pull subscription**. The
 * always-on `slack-gateway` Cloud Function receives Slack's Events-API POST,
 * verifies the signature, and publishes the event to the topic; this adapter
 * (running on the VM, which may have just been woken by that same Function)
 * pulls each message and re-injects it through the EXISTING
 * `@chat-adapter/slack` `SlackAdapter.handleWebhook()` — byte-for-byte the same
 * inbound code path as the webhook/Socket-Mode transports.
 *
 * Why pull (outbound) and not a webhook (inbound): it keeps the VM fully
 * private — no public ingress on a machine that can write to repos/prod. The
 * authoritative Slack-signature check happens at the Function (inside Slack's
 * ~5-min window); provenance into the buffer is guaranteed by Pub/Sub IAM (only
 * the Function's SA can publish). We re-forge a fresh signature here purely so
 * the inner adapter's always-on `verifySignature` passes — a buffered event may
 * be processed long after Slack's original timestamp would have gone stale.
 *
 * Each pulled message carries a `slack_type` attribute mirroring the Socket
 * Mode envelope `type`: 'events_api' | 'interactive' | 'slash_commands'.
 * Ack happens only AFTER handleWebhook resolves — i.e. after the event is
 * routed and durably written to the session inbound DB — so a stop mid-boot or
 * a crash redelivers rather than drops. The idle-stop watcher counts in-flight
 * messages so the VM never sleeps with an unacked event outstanding.
 */
import { createHmac } from 'crypto';

import { Message, PubSub, type Subscription } from '@google-cloud/pubsub';
import { createSlackAdapter, type SlackAdapter, type SlackAdapterConfig } from '@chat-adapter/slack';
import type { Adapter } from 'chat';

import { decInflightInbound, incInflightInbound } from '../idle-stop.js';
import { log } from '../log.js';

/** Adapter with the optional gateway hook the Chat SDK bridge looks for. */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

export interface SlackPubSubConfig extends SlackAdapterConfig {
  /** Fully-qualified or short Pub/Sub subscription name the gateway publishes to. */
  subscription: string;
}

/** Sign `body` with a fresh timestamp so the inner adapter's verifySignature passes. */
function signRequest(url: string, contentType: string, body: string, signingSecret: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigBase = `v0:${timestamp}:${body}`;
  const signature = 'v0=' + createHmac('sha256', signingSecret).update(sigBase).digest('hex');
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
}

/**
 * Rebuild the signed Request for a pulled Pub/Sub message, mirroring the Events
 * API shape per `slack_type`. Exported for unit testing. Returns null for an
 * unrecognized type (caller acks-and-drops to avoid poison-message loops).
 */
export function buildRequestForMessage(slackType: string, data: string, signingSecret: string): Request | null {
  switch (slackType) {
    case 'events_api':
      // `data` is the full event_callback envelope JSON — exactly the Events API body.
      return signRequest('http://localhost/slack/events', 'application/json', data, signingSecret);
    case 'interactive': {
      // `data` is the payload JSON; the Events API delivers it form-encoded under `payload=`.
      const body = `payload=${encodeURIComponent(data)}`;
      return signRequest(
        'http://localhost/slack/interactive',
        'application/x-www-form-urlencoded',
        body,
        signingSecret,
      );
    }
    case 'slash_commands': {
      // `data` is a JSON object of the command params; re-encode as a form body.
      const params = new URLSearchParams(JSON.parse(data) as Record<string, string>);
      return signRequest(
        'http://localhost/slack/commands',
        'application/x-www-form-urlencoded',
        params.toString(),
        signingSecret,
      );
    }
    default:
      return null;
  }
}

/**
 * Create a Slack adapter that uses a Pub/Sub pull subscription for inbound
 * transport. Proxies the full Adapter surface to an inner `SlackAdapter` (so
 * outbound posts/edits/reactions/typing are identical) and adds
 * `startGatewayListener()` so the Chat SDK bridge routes it through the
 * outbound/gateway path rather than registering an inbound webhook.
 */
export function createSlackPubSubAdapter(config: SlackPubSubConfig): GatewayAdapter {
  const { subscription: subscriptionName, signingSecret, ...rest } = config;
  if (!signingSecret) {
    throw new Error('Slack Pub/Sub adapter requires signingSecret to feed events through the inner adapter');
  }
  const inner: SlackAdapter = createSlackAdapter({ ...rest, signingSecret });

  const startGatewayListener: GatewayAdapter['startGatewayListener'] = (options, _durationMs, abortSignal) => {
    const pubsub = new PubSub();
    const subscription: Subscription = pubsub.subscription(subscriptionName, {
      flowControl: { maxMessages: 5 },
    });

    const onMessage = async (message: Message): Promise<void> => {
      incInflightInbound();
      const slackType = (message.attributes?.slack_type as string | undefined) ?? 'events_api';
      try {
        const req = buildRequestForMessage(slackType, message.data.toString('utf-8'), signingSecret);
        if (!req) {
          log.warn('Slack Pub/Sub: unknown slack_type — acking and dropping', { slackType, id: message.id });
          message.ack();
          return;
        }
        // handleWebhook routes the event through to the session inbound DB.
        // Awaiting it means the event is durably persisted before we ack.
        await inner.handleWebhook(req, {});
        message.ack();
      } catch (err) {
        // Nack so Pub/Sub redelivers — covers a stop mid-processing or transient error.
        log.error('Slack Pub/Sub: failed to dispatch event — nacking', { slackType, id: message.id, err });
        message.nack();
      } finally {
        decInflightInbound();
      }
    };

    subscription.on('message', (m: Message) => void onMessage(m));
    subscription.on('error', (err: unknown) => {
      log.error('Slack Pub/Sub: subscription error', { err });
    });

    const lifetime = new Promise<void>((resolve) => {
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          subscription
            .close()
            .catch((err) => log.warn('Slack Pub/Sub: close on abort failed', { err }))
            .finally(() => resolve());
        });
      }
    });
    options.waitUntil?.(lifetime);

    log.info('Slack Pub/Sub listener started', { subscription: subscriptionName });
    return Promise.resolve(new Response('ok', { status: 200 }));
  };

  // Proxy: delegate every Adapter property to the inner SlackAdapter, overlay
  // startGatewayListener. Mirrors slack-socket-mode.ts exactly.
  const overlay: Record<string | symbol, unknown> = { startGatewayListener };
  const proxy = new Proxy(inner, {
    get(target, prop) {
      if (prop in overlay) return overlay[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      return prop in overlay || prop in target;
    },
  }) as unknown as GatewayAdapter;

  return proxy;
}
