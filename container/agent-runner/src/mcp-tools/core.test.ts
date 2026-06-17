/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { setCurrentInReplyTo, clearCurrentInReplyTo } from '../current-batch.js';
import { sendMessage } from './core.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
});

afterEach(() => {
  clearCurrentInReplyTo();
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps current batch in_reply_to on outbound rows', async () => {
    setCurrentInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // No setCurrentInReplyTo before this call — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('send_message MCP tool — default routing (no `to`)', () => {
  function seedSessionRouting(channelType: string, platformId: string, threadId: string | null): void {
    const inbound = getInboundDb();
    inbound.exec(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    );
    inbound
      .prepare(
        `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, ?, ?, ?)`,
      )
      .run(channelType, platformId, threadId);
  }

  function seedInboundMessage(id: string, channelType: string, platformId: string, threadId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
         VALUES (?, 2, 'chat-sdk', datetime('now'), ?, ?, ?, '{}')`,
      )
      .run(id, platformId, channelType, threadId);
  }

  it('replies to the in-reply-to message channel, not the stale session default', async () => {
    // Agent-shared session: the session default is pinned to the CLI origin,
    // but the message being answered arrived from Slack.
    seedSessionRouting('cli', 'local', null);
    seedInboundMessage('in-slack-1', 'slack', 'slack:C0B3UPWCCQG', '1781696998.0');
    setCurrentInReplyTo('in-slack-1');

    await sendMessage.handler({ text: 'reply in place' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('slack:C0B3UPWCCQG');
    expect(out[0].thread_id).toBe('1781696998.0');
  });

  it('falls back to the session default routing when no batch is active', async () => {
    // Out-of-batch / scheduled send: no in-reply-to message to anchor on.
    seedSessionRouting('cli', 'local', null);

    await sendMessage.handler({ text: 'ad-hoc' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('cli');
    expect(out[0].platform_id).toBe('local');
  });
});
