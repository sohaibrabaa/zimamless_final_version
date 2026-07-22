import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads the repo-root .env for integration tests, which talk to a real
 * database. Values already in the environment win, so CI can override
 * without a file present.
 */
const repoRoot = join(__dirname, '..', '..', '..');

try {
  for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  // CI supplies these as environment variables.
}
