#!/usr/bin/env node
/**
 * Contract-conformance gate (Master Plan 3.2).
 *
 *   node scripts/contract-conformance.mjs <served-openapi.json>
 *
 * Diffs what the API actually serves against the frozen contract plus the
 * approved v3.1.0 overlay. This is the tripwire against silent contract
 * drift — the failure mode where Agent A's implementation and Agent B's
 * generated client diverge and nobody notices until an integration
 * checkpoint (risk R-08).
 *
 * Two directions, treated differently:
 *
 *   EXTRA paths — served but not in the contract. Always a hard failure:
 *   Agent B cannot generate a client for an endpoint that is not in the
 *   contract, so an extra path is either an accident or an unapproved
 *   amendment. `/health` is the single allowed exception, documented below.
 *
 *   MISSING paths — in the contract but not yet served. Expected during the
 *   build: Phase 1 implements 4 of 76. Reported as progress, and only fatal
 *   under --strict (used from Phase 9, when everything must exist).
 *
 * Method-level checks run for paths present on both sides, because a path
 * that exists with the wrong verb is the drift this gate is for.
 *
 * Success STATUS CODES are compared too, for path+verb pairs implemented on
 * both sides. This was added after `POST /auth/context` shipped returning
 * NestJS's default 201 where the contract specifies 200: the path and the
 * verb matched, so the gate passed while the generated client and the server
 * disagreed about the response. A status code is part of the contract.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = join(repoRoot, 'docs', '03_API_CONTRACT.yaml');
const OVERLAY = join(repoRoot, 'docs', 'amendments', 'API_v3.1.0_OVERLAY.yaml');

const strict = process.argv.includes('--strict');
const servedPath = process.argv.find((a) => a.endsWith('.json'));

if (!servedPath || !existsSync(servedPath)) {
  console.error(
    'Usage: node scripts/contract-conformance.mjs <served-openapi.json> [--strict]\n' +
      'Generate the input with:  npm run openapi:emit -w @zimmamless/api',
  );
  process.exit(1);
}

/**
 * Minimal path extractor for the two contract YAML files.
 *
 * A full YAML parser is deliberately avoided: adding a dependency to the
 * gate that guards the contract means the gate can break for reasons
 * unrelated to the contract. Both files are machine-generated in shape —
 * paths are two-space-indented keys under `paths:` and methods are
 * four-space-indented verbs — so a line scan is sufficient and has no
 * failure mode of its own.
 */
function extractPaths(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const result = new Map();
  /** `${path} ${METHOD}` → Set of success status codes. */
  const statuses = new Map();

  let inPaths = false;
  let current = null;
  let currentMethod = null;
  let inResponses = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;

    // A non-indented, non-comment key ends the paths block.
    if (/^[a-zA-Z]/.test(line)) break;

    const pathMatch = line.match(/^ {2}(\/[^\s:]*):\s*$/);
    if (pathMatch) {
      current = pathMatch[1];
      currentMethod = null;
      inResponses = false;
      result.set(current, new Set());
      continue;
    }

    const methodMatch = line.match(/^ {4}(get|post|put|patch|delete|head|options):\s*$/);
    if (methodMatch && current) {
      currentMethod = methodMatch[1].toUpperCase();
      inResponses = false;
      result.get(current).add(currentMethod);
      continue;
    }

    // `responses:` and its sibling keys sit at six spaces; the status codes
    // themselves at eight, in either block or flow style.
    const siblingKey = line.match(/^ {6}([a-zA-Z$][\w$-]*):/);
    if (siblingKey && currentMethod) {
      inResponses = siblingKey[1] === 'responses';
      continue;
    }

    if (inResponses && currentMethod) {
      const status = line.match(/^ {8}'?(\d{3})'?:/);
      if (status && status[1].startsWith('2')) {
        const key = `${current} ${currentMethod}`;
        if (!statuses.has(key)) statuses.set(key, new Set());
        statuses.get(key).add(status[1]);
      }
    }
  }

  return { paths: result, statuses };
}

/** Normalizes {id} vs {applicationId} so parameter naming is not a diff. */
const normalize = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/\/$/, '');

// --- Load the three documents ----------------------------------------------

const contract = extractPaths(CONTRACT);
const overlay = extractPaths(OVERLAY);
const contractPaths = contract.paths;
const overlayPaths = overlay.paths;

const expected = new Map();
for (const [p, methods] of [...contractPaths, ...overlayPaths]) {
  const key = normalize(p);
  if (!expected.has(key)) expected.set(key, { original: p, methods: new Set() });
  for (const m of methods) expected.get(key).methods.add(m);
}

/** `${normalizedPath} ${METHOD}` → expected success codes. Overlay wins. */
const expectedStatuses = new Map();
for (const source of [contract.statuses, overlay.statuses]) {
  for (const [key, codes] of source) {
    const [p, method] = key.split(' ');
    expectedStatuses.set(`${normalize(p)} ${method}`, codes);
  }
}

const served = JSON.parse(readFileSync(servedPath, 'utf8'));
const servedMap = new Map();
const servedStatuses = new Map();
const GLOBAL_PREFIX = /^\/v1/;

for (const [rawPath, item] of Object.entries(served.paths ?? {})) {
  // The served document carries the /v1 global prefix; the contract expresses
  // it in the servers block instead. Strip it so the two are comparable.
  const stripped = rawPath.replace(GLOBAL_PREFIX, '') || '/';
  const key = normalize(stripped);
  const methods = new Set(
    Object.keys(item)
      .filter((k) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k))
      .map((k) => k.toUpperCase()),
  );
  if (!servedMap.has(key)) servedMap.set(key, { original: rawPath, methods: new Set() });
  for (const m of methods) servedMap.get(key).methods.add(m);

  for (const m of methods) {
    const codes = Object.keys(item[m.toLowerCase()]?.responses ?? {}).filter((c) =>
      c.startsWith('2'),
    );
    if (codes.length) servedStatuses.set(`${key} ${m}`, new Set(codes));
  }
}

/**
 * /health is required by the phase file but is not in the frozen contract.
 * It is served outside the /v1 prefix, where deployment probes expect it,
 * and excluded from the OpenAPI document — so it should not appear here at
 * all. Listed as an allowance in case that changes, rather than silently
 * tolerated.
 */
const ALLOWED_EXTRA = new Set(['/health']);

// --- Compare ---------------------------------------------------------------

const extra = [];
const missing = [];
const methodMismatches = [];

for (const [key, { original, methods }] of servedMap) {
  if (ALLOWED_EXTRA.has(key)) continue;
  if (!expected.has(key)) {
    extra.push({ path: original, methods: [...methods] });
    continue;
  }
  const expectedMethods = expected.get(key).methods;
  const unexpected = [...methods].filter((m) => !expectedMethods.has(m));
  if (unexpected.length) {
    methodMismatches.push({ path: original, unexpected, expected: [...expectedMethods] });
  }
}

for (const [key, { original, methods }] of expected) {
  if (!servedMap.has(key)) missing.push({ path: original, methods: [...methods] });
}

/**
 * Status codes, for implemented path+verb pairs only. A served code that the
 * contract does not declare is drift — the generated client will not have a
 * type for it. Contract codes that are not served are not checked here: a
 * route may legitimately not produce every documented response.
 */
const statusMismatches = [];
for (const [key, servedCodes] of servedStatuses) {
  const expectedCodes = expectedStatuses.get(key);
  if (!expectedCodes) continue;
  const unexpected = [...servedCodes].filter((c) => !expectedCodes.has(c));
  if (unexpected.length) {
    statusMismatches.push({ key, served: [...servedCodes], expected: [...expectedCodes] });
  }
}

// --- Report ----------------------------------------------------------------

const totalExpected = expected.size;
const implemented = totalExpected - missing.length;

console.log('Contract conformance');
console.log(`  contract : ${CONTRACT.replace(repoRoot, '.')} (${contractPaths.size} paths)`);
console.log(`  overlay  : ${OVERLAY.replace(repoRoot, '.')} (${overlayPaths.size} paths)`);
console.log(`  served   : ${servedPath} (${servedMap.size} paths)`);
console.log(`  coverage : ${implemented}/${totalExpected} contract paths implemented\n`);

let failed = false;

if (extra.length) {
  failed = true;
  console.error('FAIL — served paths that are NOT in the contract or the approved overlay:');
  for (const e of extra) console.error(`  ${e.methods.join(',').padEnd(12)} ${e.path}`);
  console.error(
    '\n  An endpoint that is not in the contract cannot be generated by Agent B.\n' +
      '  Either remove it, or get an amendment recorded in DECISIONS.md first.\n',
  );
}

if (methodMismatches.length) {
  failed = true;
  console.error('FAIL — methods served that the contract does not define:');
  for (const m of methodMismatches) {
    console.error(`  ${m.path}: serves ${m.unexpected.join(',')}, contract has ${m.expected.join(',')}`);
  }
  console.error('');
}

if (statusMismatches.length) {
  failed = true;
  console.error('FAIL — success status codes served that the contract does not declare:');
  for (const s of statusMismatches) {
    console.error(`  ${s.key}: serves ${s.served.join(',')}, contract declares ${s.expected.join(',')}`);
  }
  console.error(
    '\n  The generated client has no type for an undeclared status. Either fix\n' +
      '  the handler (e.g. @HttpCode) or amend the contract first.\n',
  );
}

if (missing.length) {
  const label = strict ? 'FAIL' : 'not yet implemented';
  if (strict) failed = true;
  console.log(`${label} — ${missing.length} contract paths are not served:`);
  for (const m of missing.slice(0, strict ? missing.length : 10)) {
    console.log(`  ${m.methods.join(',').padEnd(12)} ${m.path}`);
  }
  if (!strict && missing.length > 10) console.log(`  … and ${missing.length - 10} more`);
  console.log('');
}

if (failed) {
  console.error('Contract conformance FAILED.');
  process.exit(1);
}

console.log(
  strict
    ? 'Contract conformance PASSED (strict: every contract path is served).'
    : 'Contract conformance PASSED (no drift; unimplemented paths are expected mid-build).',
);
