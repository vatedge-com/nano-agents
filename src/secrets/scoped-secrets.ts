import fs from 'fs';
import path from 'path';

export interface ScopedSecrets {
  CLAUDE_CODE_OAUTH_TOKEN: string; // runner credential (subscription token)
  SLACK_BOT_TOKEN?: string; // host-side: Slack adapter (Events API)
  SLACK_SIGNING_SECRET?: string; // host-side: Slack webhook verification
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
  'SLACK_SIGNING_SECRET',
  'SLACK_TEAM_ID',
  'GITHUB_TOKEN',
  'CLICKUP_API_TOKEN',
  'CLICKUP_TEAM_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

/**
 * Dev: read from local JSON file, with process.env overriding any key present
 * in the environment (non-empty values only).
 *
 * Prod (Phase 5): GCP Secret Manager — throws a clear error when
 * SECRETS_BACKEND === 'gcp'.
 */
export function getScopedSecrets(): ScopedSecrets {
  if (process.env['SECRETS_BACKEND'] === 'gcp') {
    throw new Error('GCP Secret Manager backend is wired in Phase 5');
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
