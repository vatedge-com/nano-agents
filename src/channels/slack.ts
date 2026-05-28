/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { getScopedSecrets } from '../secrets/scoped-secrets.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('slack', {
  factory: () => {
    // Credentials live in secrets.local.json (host-side scoped secrets), not
    // .env — single source of truth for all secrets in this fork.
    const secrets = getScopedSecrets();
    if (!secrets.SLACK_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: secrets.SLACK_BOT_TOKEN,
      signingSecret: secrets.SLACK_SIGNING_SECRET,
    });
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
