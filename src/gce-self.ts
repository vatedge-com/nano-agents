/**
 * GCE self-management — stop *this* instance from inside it.
 *
 * Used by the idle-stop watcher (`src/idle-stop.ts`) to power the
 * wake-on-message model: when the host has been idle long enough, it asks the
 * Compute Engine API to STOP its own VM (idle compute → $0). The VM is woken
 * again by the `slack-gateway` Cloud Function (`instances.start`) on the next
 * Slack event.
 *
 * Everything here goes through the GCE **metadata server**
 * (http://metadata.google.internal) — no SDK, no static creds. The VM's
 * attached service account must hold `compute.instances.stop` on itself.
 *
 * Off-GCE (local dev, CI) the metadata server is unreachable; `isOnGce()`
 * returns false and the idle-stop watcher never arms, so nothing here runs.
 */
import { log } from './log.js';

const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' };

async function metadata(pathSuffix: string, timeoutMs = 1000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${METADATA_BASE}${pathSuffix}`, {
      headers: METADATA_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`metadata ${pathSuffix} → ${res.status}`);
    return (await res.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

/** True when running on a GCE instance (metadata server reachable). */
export async function isOnGce(): Promise<boolean> {
  try {
    await metadata('/instance/id', 500);
    return true;
  } catch {
    return false;
  }
}

interface InstanceIdentity {
  project: string;
  zone: string; // short form, e.g. "europe-west1-b"
  name: string;
}

async function getInstanceIdentity(): Promise<InstanceIdentity> {
  const [project, zoneFull, name] = await Promise.all([
    metadata('/project/project-id'),
    metadata('/instance/zone'), // "projects/NNN/zones/europe-west1-b"
    metadata('/instance/name'),
  ]);
  const zone = zoneFull.split('/').pop() ?? zoneFull;
  return { project, zone, name };
}

async function getAccessToken(): Promise<string> {
  const raw = await metadata('/instance/service-accounts/default/token');
  const parsed = JSON.parse(raw) as { access_token?: string };
  if (!parsed.access_token) throw new Error('metadata token response missing access_token');
  return parsed.access_token;
}

/**
 * Stop this VM via the Compute Engine API. The call returns as soon as the
 * stop operation is *accepted* — the OS then receives SIGTERM, which triggers
 * the host's graceful shutdown (`src/index.ts`). Returns false (and logs) on
 * any failure so the caller can simply try again on the next idle tick.
 */
export async function stopSelf(): Promise<boolean> {
  try {
    const { project, zone, name } = await getInstanceIdentity();
    const token = await getAccessToken();
    const url = `https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${name}/stop`;
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error('stopSelf: Compute API rejected stop', { status: res.status, text, project, zone, name });
      return false;
    }
    log.info('stopSelf: stop operation accepted — VM is going to sleep', { project, zone, name });
    return true;
  } catch (err) {
    log.error('stopSelf: failed to stop instance', { err });
    return false;
  }
}
