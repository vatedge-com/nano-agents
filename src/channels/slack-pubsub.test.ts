/**
 * Unit tests for the Pub/Sub → signed-Request reconstruction. These guard the
 * contract the inner @chat-adapter/slack handleWebhook depends on: correct
 * Content-Type per slack_type, a valid v0 HMAC over `v0:<ts>:<body>`, and the
 * Events-API body shape (raw JSON for events, `payload=` form for interactive).
 */
import { createHmac } from 'crypto';

import { describe, expect, it } from 'vitest';

import { buildRequestForMessage } from './slack-pubsub.js';

const SIGNING_SECRET = 'test-signing-secret';

async function verify(req: Request): Promise<void> {
  const ts = req.headers.get('x-slack-request-timestamp')!;
  const sig = req.headers.get('x-slack-signature')!;
  const body = await req.text();
  const expected = 'v0=' + createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
  expect(sig).toBe(expected);
}

describe('buildRequestForMessage', () => {
  it('builds a JSON events_api request with a valid signature', async () => {
    const envelope = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention', text: 'hi' } });
    const req = buildRequestForMessage('events_api', envelope, SIGNING_SECRET)!;
    expect(req).not.toBeNull();
    expect(req.headers.get('content-type')).toBe('application/json');
    expect(await req.clone().text()).toBe(envelope);
    await verify(req);
  });

  it('form-encodes an interactive payload under payload=', async () => {
    const payload = JSON.stringify({ type: 'block_actions', actions: [{ value: 'approve' }] });
    const req = buildRequestForMessage('interactive', payload, SIGNING_SECRET)!;
    expect(req.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = await req.clone().text();
    expect(body).toBe(`payload=${encodeURIComponent(payload)}`);
    await verify(req);
  });

  it('re-encodes slash_command params as a form body', async () => {
    const params = JSON.stringify({ command: '/ncl', text: 'status', user_id: 'U123' });
    const req = buildRequestForMessage('slash_commands', params, SIGNING_SECRET)!;
    expect(req.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = await req.clone().text();
    expect(body).toContain('command=%2Fncl');
    expect(body).toContain('text=status');
    await verify(req);
  });

  it('returns null for an unknown slack_type', () => {
    expect(buildRequestForMessage('mystery', '{}', SIGNING_SECRET)).toBeNull();
  });
});
