/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * NOTE: OneCLI — which previously rewrote the Authorization header on the
 * wire so the real token never entered the container — has been removed.
 * This still sets ANTHROPIC_AUTH_TOKEN=placeholder, but nothing rewrites it
 * anymore, so this custom-endpoint path is currently inert. If a custom
 * Anthropic-compatible endpoint is ever needed, inject the real token
 * directly via the scoped-secrets path (see container-runner.ts), the same
 * way CLAUDE_CODE_OAUTH_TOKEN is injected for the standard path. The
 * container env here provides:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — currently a dead placeholder
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  return { env };
});
