import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads the repo-root .env into process.env.
 *
 * Imported for its side effect as the FIRST statement of every entry point,
 * before any Nest module is constructed — configuration is validated during
 * dependency injection, so anything loaded later is already too late.
 *
 * The variables live at the repo root rather than in apps/api because the
 * migration runner, the seed, and the integration tests read the same
 * DATABASE_URL. One file, one source of truth; a per-package copy is how
 * the API ends up migrating a different database than the tests verify.
 *
 * Values already present in the environment always win, so a real
 * deployment (Render, CI) is never overridden by a stray file.
 */
export function loadEnv(): void {
  // dist/config/load-env.js → apps/api/dist/config → repo root is four up.
  const candidates = [
    join(__dirname, '..', '..', '..', '..', '.env'),
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '..', '.env'),
  ];

  for (const path of candidates) {
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    for (const line of contents.split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, '');
    }
    return;
  }
  // No file found: expected in CI and on Render, where the platform supplies
  // the environment directly. Config validation reports anything missing.
}
