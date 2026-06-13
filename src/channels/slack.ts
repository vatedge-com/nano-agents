/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Transport selection (first match wins):
 *   - When `SLACK_GATEWAY_SUBSCRIPTION` is set, we use the Pub/Sub adapter — the
 *     wake-on-message transport. Inbound events are pulled from a Pub/Sub
 *     subscription fed by the always-on `slack-gateway` Cloud Function, so the
 *     VM stays private and can sleep when idle. Routed through the gateway path.
 *   - Else when a Slack app-level token (`SLACK_APP_TOKEN`, an `xapp-…`) is
 *     present, we use the Socket Mode adapter (outbound WebSocket — no public
 *     webhook endpoint required). Routed through the gateway path too.
 *   - Otherwise we fall back to the webhook/Events-API adapter (inbound HTTP).
 *
 * Both paths wrap the SAME `@chat-adapter/slack` logic and the SAME
 * `createChatSdkBridge(...)` call, so routing, threading, replies, and the
 * "Typing…" status (assistant.threads.setStatus) behave identically — only the
 * inbound transport changes.
 */
import { createSlackAdapter, type SlackAdapter } from '@chat-adapter/slack';

import { SLACK_GATEWAY_SUBSCRIPTION } from '../config.js';
import { getScopedSecrets } from '../secrets/scoped-secrets.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { createSlackPubSubAdapter } from './slack-pubsub.js';
import { createSlackSocketModeAdapter } from './slack-socket-mode.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('slack', {
  factory: () => {
    // Credentials live in secrets.local.json (host-side scoped secrets), not
    // .env — single source of truth for all secrets in this fork.
    const secrets = getScopedSecrets();
    if (!secrets.SLACK_BOT_TOKEN) return null;

    // Pub/Sub (wake-on-message) > Socket Mode (xapp token) > webhook fallback.
    // We type the adapter as the inner SlackAdapter for the resolveChannelName
    // fallback below — the Pub/Sub and Socket Mode wrappers both proxy
    // fetchThread through to the same inner adapter, so the cast holds for all
    // three transports.
    const usePubSub = SLACK_GATEWAY_SUBSCRIPTION.length > 0;
    const useSocketMode = typeof secrets.SLACK_APP_TOKEN === 'string' && secrets.SLACK_APP_TOKEN.startsWith('xapp-');
    const slackAdapter = (
      usePubSub
        ? createSlackPubSubAdapter({
            subscription: SLACK_GATEWAY_SUBSCRIPTION,
            botToken: secrets.SLACK_BOT_TOKEN,
            signingSecret: secrets.SLACK_SIGNING_SECRET,
          })
        : useSocketMode
          ? createSlackSocketModeAdapter({
              appToken: secrets.SLACK_APP_TOKEN!,
              botToken: secrets.SLACK_BOT_TOKEN,
              signingSecret: secrets.SLACK_SIGNING_SECRET,
            })
          : createSlackAdapter({
              botToken: secrets.SLACK_BOT_TOKEN,
              signingSecret: secrets.SLACK_SIGNING_SECRET,
            })
    ) as SlackAdapter;

    const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
});
