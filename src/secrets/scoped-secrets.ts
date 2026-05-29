import fs from 'fs';
import path from 'path';

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

import { log } from '../log.js';

export interface ScopedSecrets {
  CLAUDE_CODE_OAUTH_TOKEN: string; // runner credential (subscription token)
  SLACK_BOT_TOKEN?: string; // host-side: Slack adapter (xoxb- bot token)
  SLACK_APP_TOKEN?: string; // host-side: Slack Socket Mode app-level token (xapp-)
  SLACK_SIGNING_SECRET?: string; // host-side: Slack webhook / Socket Mode event verification
  SLACK_TEAM_ID?: string; // Slack workspace id (T0B0H0WKZEZ)
  GITHUB_TOKEN?: string;
  CLICKUP_API_TOKEN?: string; // ClickUp pk_ personal API token
  CLICKUP_TEAM_ID?: string; // ClickUp workspace/team id
  GOOGLE_APPLICATION_CREDENTIALS?: string; // path inside container to SA key json
  [key: string]: string | undefined;
}

// Known keys in the ScopedSecrets shape — used for env override scanning.
const KNOWN_KEYS: ReadonlyArray<keyof ScopedSecrets> = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_TEAM_ID',
  'GITHUB_TOKEN',
  'CLICKUP_API_TOKEN',
  'CLICKUP_TEAM_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

/**
 * Keys fetched from GCP Secret Manager in `gcp` mode. Each maps to a secret
 * named `dev-agent-<lowercased_key>` (e.g. CLAUDE_CODE_OAUTH_TOKEN →
 * `dev-agent-claude_code_oauth_token`). GOOGLE_APPLICATION_CREDENTIALS is
 * intentionally excluded — it stays an on-disk path supplied via env.
 */
const GCP_SECRET_KEYS: ReadonlyArray<keyof ScopedSecrets> = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'GITHUB_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_TEAM_ID',
  'CLICKUP_API_TOKEN',
  'CLICKUP_TEAM_ID',
];

// Process-lifetime cache for the gcp backend. getScopedSecrets() is sync and
// called on hot paths, so the async fetch happens once via
// prefetchScopedSecrets() at startup and every subsequent call serves this.
let gcpCache: ScopedSecrets | null = null;

function gcpProject(): string {
  return process.env['GCP_PROJECT'] ?? 'vatedge-prod';
}

/**
 * Fetch each `dev-agent-<key>` secret (version `latest`) from GCP Secret
 * Manager into a ScopedSecrets object using ADC (no key file). A missing or
 * empty secret is tolerated (skipped). Never logs secret values — only key
 * names.
 */
async function loadFromGcp(): Promise<ScopedSecrets> {
  const client = new SecretManagerServiceClient();
  const project = gcpProject();
  const secrets: ScopedSecrets = {} as ScopedSecrets;

  // GOOGLE_APPLICATION_CREDENTIALS is an on-disk path from env, not a fetch.
  const gac = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (typeof gac === 'string' && gac.length > 0) {
    secrets.GOOGLE_APPLICATION_CREDENTIALS = gac;
  }

  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const key of GCP_SECRET_KEYS) {
    const secretId = `dev-agent-${String(key).toLowerCase()}`;
    const name = `projects/${project}/secrets/${secretId}/versions/latest`;
    try {
      const [version] = await client.accessSecretVersion({ name });
      const payload = version.payload?.data;
      const value = payload
        ? Buffer.from(payload as Uint8Array)
            .toString('utf-8')
            .trim()
        : '';
      if (value.length > 0) {
        secrets[key] = value;
        loaded.push(String(key));
      } else {
        skipped.push(String(key));
      }
    } catch (err) {
      // Tolerate missing/empty secrets (e.g. SLACK_APP_TOKEN may not exist).
      // Log the key name + error only — never the value.
      skipped.push(String(key));
      log.debug('GCP secret not available', { secretId, project, err: (err as Error).message });
    }
  }
  log.info('Loaded secrets from GCP Secret Manager', { project, loaded, skipped });
  return secrets;
}

/**
 * Populate the gcp secret cache. Call once at startup (before channel adapters
 * / container spawning) when SECRETS_BACKEND === 'gcp'. No-op for other
 * backends.
 */
export async function prefetchScopedSecrets(): Promise<void> {
  if (process.env['SECRETS_BACKEND'] !== 'gcp') return;
  gcpCache = await loadFromGcp();
}

/**
 * Dev: read from local JSON file, with process.env overriding any key present
 * in the environment (non-empty values only).
 *
 * Prod: GCP Secret Manager — served synchronously from the cache populated by
 * prefetchScopedSecrets() at startup.
 */
export function getScopedSecrets(): ScopedSecrets {
  if (process.env['SECRETS_BACKEND'] === 'gcp') {
    if (!gcpCache) {
      throw new Error(
        'GCP secrets not prefetched. Call await prefetchScopedSecrets() during startup before getScopedSecrets().',
      );
    }
    return gcpCache;
  }

  const secretsFile = process.env['SECRETS_FILE'] ?? path.resolve(process.cwd(), 'secrets.local.json');

  if (!fs.existsSync(secretsFile)) {
    throw new Error(
      `Secrets file not found. Create secrets.local.json in the project root or set SECRETS_FILE. Expected: ${secretsFile}`,
    );
  }

  const raw = fs.readFileSync(secretsFile, 'utf-8');

  let fromFile: Record<string, unknown>;
  try {
    fromFile = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse secrets file as JSON: ${secretsFile}`);
  }

  if (typeof fromFile !== 'object' || fromFile === null || Array.isArray(fromFile)) {
    throw new Error(`Secrets file must contain a JSON object: ${secretsFile}`);
  }

  // Start from file values, cast to string where present.
  const secrets: ScopedSecrets = {} as ScopedSecrets;

  for (const key of Object.keys(fromFile)) {
    secrets[key] = typeof fromFile[key] === 'string' ? (fromFile[key] as string) : undefined;
  }

  // Apply env overrides: if process.env[KEY] is non-empty, it wins.
  const allKeys = new Set<string>([...(KNOWN_KEYS as string[]), ...Object.keys(fromFile)]);
  for (const key of allKeys) {
    const envVal = process.env[key];
    if (typeof envVal === 'string' && envVal.length > 0) {
      secrets[key] = envVal;
    }
  }

  return secrets;
}

/**
 * Returns only the defined, non-empty secret values as a flat Record for env
 * injection.  Never logs secret values.
 */
export function secretsForContainer(s: ScopedSecrets): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(s)) {
    const val = s[key];
    if (typeof val === 'string' && val.length > 0) {
      result[key] = val;
    }
  }
  return result;
}
