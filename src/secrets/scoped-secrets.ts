import fs from 'fs';
import path from 'path';

export interface ScopedSecrets {
  CLAUDE_CODE_OAUTH_TOKEN: string; // runner credential (subscription token)
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
  GITHUB_TOKEN?: string;
  CLICKUP_API_TOKEN?: string;
  [key: string]: string | undefined;
}

// Known keys in the ScopedSecrets shape — used for env override scanning.
const KNOWN_KEYS: ReadonlyArray<keyof ScopedSecrets> = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'GITHUB_TOKEN',
  'CLICKUP_API_TOKEN',
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

  const raw = fs.readFileSync(secretsFile, 'utf-8');
  const fromFile = JSON.parse(raw) as Record<string, unknown>;

  // Start from file values, cast to string where present.
  const secrets: ScopedSecrets = {
    CLAUDE_CODE_OAUTH_TOKEN:
      typeof fromFile['CLAUDE_CODE_OAUTH_TOKEN'] === 'string' ? fromFile['CLAUDE_CODE_OAUTH_TOKEN'] : '',
  };

  for (const key of Object.keys(fromFile)) {
    if (key !== 'CLAUDE_CODE_OAUTH_TOKEN') {
      secrets[key] = typeof fromFile[key] === 'string' ? (fromFile[key] as string) : undefined;
    }
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
