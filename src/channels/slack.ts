/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Transport selection:
 *   - When a Slack app-level token (`SLACK_APP_TOKEN`, an `xapp-…`) is present,
 *     we use the Socket Mode adapter (outbound WebSocket — no public webhook
 *     endpoint required). The bridge routes it through the gateway/outbound
 *     path because it exposes `startGatewayListener()`.
 *   - Otherwise we fall back to the webhook/Events-API adapter (inbound HTTP).
 *
 * Both paths wrap the SAME `@chat-adapter/slack` logic and the SAME
 * `createChatSdkBridge(...)` call, so routing, threading, replies, and the
 * "Typing…" status (assistant.threads.setStatus) behave identically — only the
 * inbound transport changes.
 */
import { createSlackAdapter, type SlackAdapter } from '@chat-adapter/slack';

import { getScopedSecrets } from '../secrets/scoped-secrets.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { createSlackSocketModeAdapter } from './slack-socket-mode.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('slack', {
  factory: () => {
    // Credentials live in secrets.local.json (host-side scoped secrets), not
    // .env — single source of truth for all secrets in this fork.
    const secrets = getScopedSecrets();
    if (!secrets.SLACK_BOT_TOKEN) return null;

    // Socket Mode when an app-level token is available; webhook otherwise.
    // We type the adapter as the inner SlackAdapter for the resolveChannelName
    // fallback below — the Socket Mode wrapper proxies fetchThread through to
    // the same inner adapter, so the cast holds for both transports.
    const useSocketMode = typeof secrets.SLACK_APP_TOKEN === 'string' && secrets.SLACK_APP_TOKEN.startsWith('xapp-');
    const slackAdapter = (
      useSocketMode
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
