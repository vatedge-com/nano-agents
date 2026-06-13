/**
 * Idle-stop watcher — the "sleep" half of the wake-on-message model.
 *
 * When the host has done nothing for `IDLE_STOP_MINUTES`, it stops its own GCE
 * VM (`src/gce-self.ts`). The `slack-gateway` Cloud Function wakes it again on
 * the next Slack event. Idle compute therefore costs ~$0 while every feature
 * (Docker sandbox, self-mod, skills, claude-mem, SQLite state on the persistent
 * data disk) is preserved untouched across the stop/start cycle.
 *
 * "Idle" = no agent container running AND no Slack event in flight, sustained
 * for the whole window. Any new activity resets the clock, so an active
 * conversation keeps the VM continuously warm — the countdown only runs from
 * the *last* message. The hard guards (active containers / in-flight events)
 * mean we never stop mid-task; the gateway is the safety net (a buffered
 * message simply re-starts the VM).
 *
 * Activity + in-flight counters live here (not in the Slack adapter) so the
 * dependency runs one way: the Pub/Sub adapter imports this module, never the
 * reverse.
 */
import { IDLE_STOP_MS } from './config.js';
import { getActiveContainerCount } from './container-runner.js';
import { isOnGce, stopSelf } from './gce-self.js';
import { log } from './log.js';

const TICK_MS = 60_000;

let lastActivityMs = Date.now();
let inflightInbound = 0;

/** Record host activity — resets the idle countdown. */
export function markActivity(): void {
  lastActivityMs = Date.now();
}

/** Slack adapter: an inbound event began processing (held off sleep). */
export function incInflightInbound(): void {
  inflightInbound += 1;
  markActivity();
}

/** Slack adapter: an inbound event finished (acked or nacked). */
export function decInflightInbound(): void {
  inflightInbound = Math.max(0, inflightInbound - 1);
}

export function getInflightInbound(): number {
  return inflightInbound;
}

export type IdleDecision =
  | { action: 'reset' } // busy this tick — bump the clock
  | { action: 'wait'; idleMs: number } // idle but inside the window
  | { action: 'stop'; idleMs: number }; // idle past the window — go to sleep

/**
 * Pure idle decision. All inputs are deterministic so this is unit-testable;
 * the timer, container count read, and the actual stop happen in the caller.
 */
export function decideIdleStop(args: {
  now: number;
  lastActivityMs: number;
  activeContainers: number;
  inflightInbound: number;
  idleStopMs: number;
}): IdleDecision {
  const { now, lastActivityMs: last, activeContainers, inflightInbound: inflight, idleStopMs } = args;
  if (activeContainers > 0 || inflight > 0) return { action: 'reset' };
  const idleMs = now - last;
  if (idleMs >= idleStopMs) return { action: 'stop', idleMs };
  return { action: 'wait', idleMs };
}

let running = false;
let timer: NodeJS.Timeout | null = null;
let stopping = false;

async function tick(): Promise<void> {
  if (!running) return;
  try {
    const decision = decideIdleStop({
      now: Date.now(),
      lastActivityMs,
      activeContainers: getActiveContainerCount(),
      inflightInbound,
      idleStopMs: IDLE_STOP_MS,
    });
    if (decision.action === 'reset') {
      lastActivityMs = Date.now();
    } else if (decision.action === 'stop' && !stopping) {
      stopping = true;
      log.info('Idle-stop: window elapsed — stopping VM', { idleMs: decision.idleMs, idleStopMs: IDLE_STOP_MS });
      const ok = await stopSelf();
      // If the stop call failed, allow a retry on the next tick.
      if (!ok) stopping = false;
    }
  } catch (err) {
    log.error('Idle-stop tick error', { err });
  }
  if (running) timer = setTimeout(() => void tick(), TICK_MS);
}

/**
 * Arm the idle-stop watcher. No-op unless IDLE_STOP_MINUTES > 0 *and* we are on
 * a GCE instance — so local dev / CI never sleep. Safe to call once at startup.
 */
export async function startIdleStop(): Promise<void> {
  if (running) return;
  if (IDLE_STOP_MS <= 0) {
    log.info('Idle-stop disabled (IDLE_STOP_MINUTES unset or 0)');
    return;
  }
  if (!(await isOnGce())) {
    log.info('Idle-stop disabled (not running on GCE)');
    return;
  }
  running = true;
  lastActivityMs = Date.now();
  log.info('Idle-stop watcher started', { idleStopMs: IDLE_STOP_MS });
  timer = setTimeout(() => void tick(), TICK_MS);
}

export function stopIdleStop(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
