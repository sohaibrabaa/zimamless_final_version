#!/usr/bin/env node
/**
 * Generates db/migrations/0001_frozen_schema.sql from docs/02_DATABASE_SCHEMA.sql.
 *
 * Migration 0001 IS the frozen schema. The generator exists so that
 * "0001 == the frozen file" is mechanically verifiable rather than asserted:
 * the only permitted transformation is removing the single statement ruled
 * invalid in DECISIONS.md RULING D-01 (partial-index predicates cannot contain
 * subqueries, so the frozen file does not execute as written). Its
 * behaviour-identical replacement ships in migration 0002.
 *
 *   node db/tools/build-0001.mjs           # write
 *   node db/tools/build-0001.mjs --check   # verify checked-in file matches (CI)
 *
 * Any other divergence between the frozen file and 0001 is a protocol
 * violation and fails CI.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FROZEN = join(repoRoot, 'docs', '02_DATABASE_SCHEMA.sql');
const OUT = join(repoRoot, 'db', 'migrations', '0001_frozen_schema.sql');

/** The exact D-01 statement, matched structurally so a reformat fails loudly. */
const D01_STATEMENT =
  /-- ZM-VER-001 \+ ZM-CON-017: no duplicate active invoice\r?\nCREATE UNIQUE INDEX uq_active_invoice_fingerprint\r?\n[\s\S]*?\);\r?\n/;

const HEADER = `-- =====================================================================
-- MIGRATION 0001 — FROZEN SCHEMA (GENERATED — DO NOT EDIT BY HAND)
-- =====================================================================
-- Source:    docs/02_DATABASE_SCHEMA.sql (schema version 3.0.0, FROZEN)
-- Generator: db/tools/build-0001.mjs   (CI verifies this file matches)
--
-- The ONLY transformation applied to the frozen file is the removal of
-- the statement creating index uq_active_invoice_fingerprint, per
-- docs/coordination/DECISIONS.md RULING D-01 (2026-07-22): the partial
-- index predicate contains a subquery, which PostgreSQL rejects, so the
-- frozen file does not execute as written. The behaviour-identical
-- replacement (trigger-maintained invoices.is_active_fingerprint + a
-- partial unique index on it) ships in migration 0002 §D-01.
--
-- To change this file, change the frozen schema (product owner only) and
-- re-run the generator. Editing it directly will fail the CI check.
-- =====================================================================

`;

const frozen = readFileSync(FROZEN, 'utf8');

if (!D01_STATEMENT.test(frozen)) {
  console.error(
    'FATAL: the D-01 statement was not found in the frozen schema.\n' +
      'Either the frozen file changed (product owner action — re-verify the ruling)\n' +
      'or this generator is stale. Refusing to emit a migration.',
  );
  process.exit(1);
}

const body = frozen.replace(
  D01_STATEMENT,
  '-- [D-01] The uq_active_invoice_fingerprint index from the frozen schema is\n' +
    '-- omitted here (invalid PostgreSQL). Replacement in migration 0002 §D-01.\n\n',
);
const generated = HEADER + body;

if (process.argv.includes('--check')) {
  let current;
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error(`FAIL: ${OUT} does not exist. Run: node db/tools/build-0001.mjs`);
    process.exit(1);
  }
  if (current !== generated) {
    console.error(
      'FAIL: db/migrations/0001_frozen_schema.sql does not match the frozen schema.\n' +
        'Migration 0001 must be the frozen schema verbatim minus the D-01 statement.\n' +
        'Run: node db/tools/build-0001.mjs',
    );
    process.exit(1);
  }
  console.log('OK: migration 0001 matches docs/02_DATABASE_SCHEMA.sql (D-01 omitted).');
} else {
  writeFileSync(OUT, generated);
  console.log(`Wrote ${OUT} (${generated.length} bytes).`);
}
