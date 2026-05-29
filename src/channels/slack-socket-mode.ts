/**
 * Slack Socket Mode adapter — outbound-websocket transport wrapper.
 *
 * Behavior-preserving transport swap: instead of receiving Slack events via an
 * inbound HTTP webhook (Events API), this adapter opens an OUTBOUND WebSocket
 * (Socket Mode) using an app-level token (`xapp-…`) and feeds every received
 * event back through the EXISTING `@chat-adapter/slack` `SlackAdapter` logic.
 *
 * The inner `SlackAdapter` (from `createSlackAdapter`) is reused verbatim for:
 *   - event parsing + dispatch (`parseMessage`, message/mention/DM/assistant
 *     routing, self-message filtering via `isMessageFromSelf`),
 *   - all OUTBOUND calls (`postMessage`/`editMessage`/`addReaction`, and the
 *     "Typing…" status via `startTyping` → `assistant.threads.setStatus`),
 *   - thread-id encode/decode + `channelIdFromThreadId`.
 *
 * The ONLY thing this wrapper changes is the transport: it exposes
 * `startGatewayListener()` so the Chat SDK bridge routes it through the
 * outbound/gateway path (like Discord) rather than registering an inbound
 * webhook. Each Socket Mode envelope is re-serialized into the exact `Request`
 * shape the Events API webhook would have delivered — including a freshly
 * computed Slack signature — and handed to `inner.handleWebhook()`. This means
 * the inbound code path is byte-for-byte identical to the webhook path; nothing
 * about routing, threading, replies, or the typing indicator differs.
 */
import { createHmac } from 'crypto';

import { SocketModeClient } from '@slack/socket-mode';
import { createSlackAdapter, type SlackAdapter, type SlackAdapterConfig } from '@chat-adapter/slack';
import type { Adapter } from 'chat';

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

export interface SlackSocketModeConfig extends SlackAdapterConfig {
  /** App-level token (xapp-…) used to open the Socket Mode WebSocket. */
  appToken: string;
}

/**
 * Build a signed Request equivalent to what Slack's Events API would POST to a
 * webhook endpoint, so the inner adapter's `handleWebhook` accepts it. Socket
 * Mode envelopes are already authenticated by the WebSocket handshake; we
 * recompute the HMAC over the JSON body purely so the inner adapter's
 * `verifySignature` (which always runs) passes — no behavior changes.
 */
function buildSignedRequest(body: string, signingSecret: string): Request {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigBase = `v0:${timestamp}:${body}`;
  const signature = 'v0=' + createHmac('sha256', signingSecret).update(sigBase).digest('hex');
  return new Request('http://localhost/slack/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
}

/**
 * Build a signed Request for an interactive (form-urlencoded) payload — block
 * actions / view submissions arrive over Socket Mode as the same payload the
 * Events API would deliver form-encoded under `payload=`.
 */
function buildSignedInteractiveRequest(payloadJson: string, signingSecret: string): Request {
  const body = `payload=${encodeURIComponent(payloadJson)}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sigBase = `v0:${timestamp}:${body}`;
  const signature = 'v0=' + createHmac('sha256', signingSecret).update(sigBase).digest('hex');
  return new Request('http://localhost/slack/interactive', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signature,
    },
    body,
  });
}

/**
 * Create a Slack adapter that uses Socket Mode for inbound transport.
 *
 * Returns an object that proxies the full Chat SDK `Adapter` surface to an
 * inner `SlackAdapter` and adds `startGatewayListener()`. The bridge detects
 * that method and routes this adapter through the outbound/gateway path.
 */
export function createSlackSocketModeAdapter(config: SlackSocketModeConfig): GatewayAdapter {
  const { appToken, signingSecret, ...rest } = config;
  if (!signingSecret) {
    // The inner adapter's handleWebhook always verifies signatures, and we
    // forge them with the signing secret. Without it, every forged Request
    // would be rejected and no inbound event would ever reach the bridge.
    throw new Error('Slack Socket Mode adapter requires signingSecret to feed events through the inner adapter');
  }
  const inner: SlackAdapter = createSlackAdapter({ ...rest, signingSecret });

  const startGatewayListener: GatewayAdapter['startGatewayListener'] = (
    options,
    _durationMs,
    abortSignal,
  ): Promise<Response> => {
    // autoReconnectEnabled defaults to true — socket-mode handles transient
    // disconnects internally, so we do NOT treat a 'disconnected' event as a
    // reason to resolve the lifetime promise (that would make the bridge spawn
    // a second listener). Only an explicit abort tears the connection down.
    const client = new SocketModeClient({ appToken });

    // Generic catch-all: every event/interactive envelope flows through here.
    // We ACK immediately (Slack requires ack within 3s) then re-inject the
    // payload through the inner adapter's webhook handler — identical to the
    // Events API path.
    client.on(
      'slack_event',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async ({ ack, type, body }: { ack: () => Promise<void>; type: string; body: any }) => {
        try {
          await ack();
        } catch (err) {
          log.warn('Slack Socket Mode: ack failed', { type, err });
        }

        try {
          if (type === 'interactive') {
            const req = buildSignedInteractiveRequest(JSON.stringify(body), signingSecret);
            await inner.handleWebhook(req, {});
            return;
          }
          // events_api (and any other JSON envelope, e.g. slash_commands which
          // the inner adapter also routes). `body` is the full envelope
          // ({ type: 'event_callback', event, team_id, ... }) — exactly what
          // the Events API POSTs.
          if (type === 'events_api' || (body && body.type === 'event_callback')) {
            const req = buildSignedRequest(JSON.stringify(body), signingSecret);
            await inner.handleWebhook(req, {});
            return;
          }
          // slash_commands arrive form-encoded over the Events API; mirror that.
          if (type === 'slash_commands') {
            const params = new URLSearchParams(body as Record<string, string>);
            const formBody = params.toString();
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const sigBase = `v0:${timestamp}:${formBody}`;
            const signature = 'v0=' + createHmac('sha256', signingSecret).update(sigBase).digest('hex');
            const req = new Request('http://localhost/slack/commands', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-slack-request-timestamp': timestamp,
                'x-slack-signature': signature,
              },
              body: formBody,
            });
            await inner.handleWebhook(req, {});
            return;
          }
          log.debug('Slack Socket Mode: ignored envelope type', { type });
        } catch (err) {
          log.error('Slack Socket Mode: failed to dispatch event', { type, err });
        }
      },
    );

    client.on('error', (err: unknown) => {
      log.error('Slack Socket Mode: socket error', { err });
    });
    client.on('disconnected', (err: unknown) => {
      // Expected/transient under autoReconnect — informational only.
      log.warn('Slack Socket Mode: disconnected (auto-reconnect will retry)', { err });
    });

    // The Chat SDK bridge expects startGatewayListener to resolve quickly with
    // a Response while the long-running connection lives on. The bridge passes
    // a `waitUntil` to capture that long-running work and reschedules only when
    // it resolves. Since socket-mode auto-reconnects internally, we resolve the
    // lifetime ONLY on an explicit abort (host shutdown / teardown) — never on a
    // transient 'disconnected' — to avoid duplicate listeners.
    const connectionLifetime = new Promise<void>((resolve) => {
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          client.disconnect().catch((err) => log.warn('Slack Socket Mode: disconnect on abort failed', { err }));
          resolve();
        });
      }
      client.start().catch((err) => {
        log.error('Slack Socket Mode: start failed', { err });
        resolve();
      });
    });
    options.waitUntil?.(connectionLifetime);

    log.info('Slack Socket Mode listener started');
    return Promise.resolve(new Response('ok', { status: 200 }));
  };

  // Proxy: delegate every Adapter property to the inner SlackAdapter, then
  // overlay startGatewayListener. Using a Proxy keeps the full surface
  // (postMessage, editMessage, addReaction, startTyping, channelIdFromThreadId,
  // encodeThreadId/decodeThreadId, isDM, fetchThread, openDM, parseMessage,
  // initialize, name, userName, …) byte-for-byte identical to the webhook path.
  const overlay: Record<string | symbol, unknown> = { startGatewayListener };
  const proxy = new Proxy(inner, {
    get(target, prop) {
      if (prop in overlay) return overlay[prop];
      const value = Reflect.get(target, prop, target);
      // Bind methods to the inner adapter so its private fields resolve.
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      return prop in overlay || prop in target;
    },
  }) as unknown as GatewayAdapter;

  return proxy;
}
