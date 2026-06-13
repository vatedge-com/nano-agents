/**
 * Unit tests for the pure idle-stop decision (`decideIdleStop`). Lives on the
 * pure helper so we don't have to mock the container runner, the timer, or the
 * GCE metadata server.
 */
import { describe, expect, it } from 'vitest';

import { decideIdleStop } from './idle-stop.js';

const NOW = Date.parse('2026-06-13T12:00:00.000Z');
const IDLE_MS = 30 * 60_000;

describe('decideIdleStop', () => {
  it('resets while a container is active, even if long idle by the clock', () => {
    expect(
      decideIdleStop({
        now: NOW,
        lastActivityMs: NOW - 10 * IDLE_MS,
        activeContainers: 1,
        inflightInbound: 0,
        idleStopMs: IDLE_MS,
      }),
    ).toEqual({ action: 'reset' });
  });

  it('resets while a Slack event is in flight (never sleeps with unacked work)', () => {
    expect(
      decideIdleStop({
        now: NOW,
        lastActivityMs: NOW - 10 * IDLE_MS,
        activeContainers: 0,
        inflightInbound: 1,
        idleStopMs: IDLE_MS,
      }),
    ).toEqual({ action: 'reset' });
  });

  it('waits when idle but still inside the window', () => {
    const res = decideIdleStop({
      now: NOW,
      lastActivityMs: NOW - (IDLE_MS - 60_000),
      activeContainers: 0,
      inflightInbound: 0,
      idleStopMs: IDLE_MS,
    });
    expect(res.action).toBe('wait');
  });

  it('stops once idle past the full window', () => {
    const res = decideIdleStop({
      now: NOW,
      lastActivityMs: NOW - (IDLE_MS + 1_000),
      activeContainers: 0,
      inflightInbound: 0,
      idleStopMs: IDLE_MS,
    });
    expect(res.action).toBe('stop');
  });

  it('stops exactly at the window boundary', () => {
    const res = decideIdleStop({
      now: NOW,
      lastActivityMs: NOW - IDLE_MS,
      activeContainers: 0,
      inflightInbound: 0,
      idleStopMs: IDLE_MS,
    });
    expect(res.action).toBe('stop');
  });
});
