import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getScopedSecrets, secretsForContainer } from './scoped-secrets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeTempSecrets(data: Record<string, string>): string {
  const file = path.join(os.tmpdir(), `scoped-secrets-test-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(data), 'utf-8');
  return file;
}

// Save and restore env vars mutated by tests so state doesn't leak.
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getScopedSecrets', () => {
  let tmpFile: string | undefined;

  beforeEach(() => {
    tmpFile = undefined;
  });

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('reads secrets from the file pointed to by SECRETS_FILE', () => {
    tmpFile = writeTempSecrets({
      CLAUDE_CODE_OAUTH_TOKEN: 'token-from-file',
      SLACK_BOT_TOKEN: 'slack-from-file',
    });

    withEnv(
      {
        SECRETS_FILE: tmpFile,
        SECRETS_BACKEND: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        SLACK_BOT_TOKEN: undefined,
      },
      () => {
        const secrets = getScopedSecrets();
        expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-from-file');
        expect(secrets.SLACK_BOT_TOKEN).toBe('slack-from-file');
      },
    );
  });

  it('process.env value overrides the file value for any key', () => {
    tmpFile = writeTempSecrets({
      CLAUDE_CODE_OAUTH_TOKEN: 'token-from-file',
      SLACK_BOT_TOKEN: 'slack-from-file',
    });

    withEnv(
      {
        SECRETS_FILE: tmpFile,
        SECRETS_BACKEND: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: 'token-from-env',
        SLACK_BOT_TOKEN: undefined,
      },
      () => {
        const secrets = getScopedSecrets();
        expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-from-env');
        // file value still visible when env not set for that key
        expect(secrets.SLACK_BOT_TOKEN).toBe('slack-from-file');
      },
    );
  });

  it('empty string env var does NOT override file value', () => {
    tmpFile = writeTempSecrets({
      CLAUDE_CODE_OAUTH_TOKEN: 'token-from-file',
    });

    withEnv(
      {
        SECRETS_FILE: tmpFile,
        SECRETS_BACKEND: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: '',
      },
      () => {
        const secrets = getScopedSecrets();
        expect(secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-from-file');
      },
    );
  });

  it('throws a clear error when SECRETS_BACKEND === "gcp"', () => {
    tmpFile = writeTempSecrets({ CLAUDE_CODE_OAUTH_TOKEN: '' });

    withEnv({ SECRETS_FILE: tmpFile, SECRETS_BACKEND: 'gcp' }, () => {
      expect(() => getScopedSecrets()).toThrow('GCP Secret Manager backend is wired in Phase 5');
    });
  });
});

describe('secretsForContainer', () => {
  it('returns only non-empty string values as a flat Record', () => {
    const result = secretsForContainer({
      CLAUDE_CODE_OAUTH_TOKEN: 'my-token',
      SLACK_BOT_TOKEN: '',
      SLACK_APP_TOKEN: undefined,
      GITHUB_TOKEN: 'gh-xyz',
    });

    expect(result).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'my-token',
      GITHUB_TOKEN: 'gh-xyz',
    });
  });

  it('returns an empty Record when all values are empty or undefined', () => {
    const result = secretsForContainer({
      CLAUDE_CODE_OAUTH_TOKEN: '',
      SLACK_BOT_TOKEN: undefined,
    });

    expect(result).toEqual({});
  });

  it('returns all defined non-empty values', () => {
    const result = secretsForContainer({
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      SLACK_BOT_TOKEN: 'slk',
      SLACK_APP_TOKEN: 'app',
      GITHUB_TOKEN: 'git',
      CLICKUP_API_TOKEN: 'cup',
    });

    expect(Object.keys(result)).toHaveLength(5);
  });
});
