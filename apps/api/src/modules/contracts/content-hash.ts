import { createHash } from 'node:crypto';

/**
 * Content hashing for the two things this phase freezes: the accepted-offer
 * snapshot (ZM-SEL-007) and the contract terms (ZM-CON-005).
 *
 * A hash over `JSON.stringify(value)` would be worthless for this purpose.
 * `JSON.stringify` preserves insertion order, so the same terms assembled by
 * two different code paths — or by the same code path after someone reorders
 * a field in an interface — produce different bytes and therefore a different
 * hash. The hash would then detect edits it should ignore and miss edits it
 * should catch, which is the worst of both.
 *
 * So the value is canonicalized first:
 *
 *   - object keys sorted lexicographically, recursively
 *   - arrays keep their order, because in a snapshot an array IS ordered
 *     (the conditions on an offer have a display order that is part of what
 *     was agreed)
 *   - `undefined` and absent members are the same thing and are dropped;
 *     `null` is a value and is kept
 *   - numbers are rejected outright
 *
 * That last rule deserves the space. Money in this system is a 3-dp string
 * everywhere, and `0.1 + 0.2` is the reason. If a caller hands a JS number to
 * the hasher, either it came from money — in which case it has already lost
 * precision and hashing it would certify a wrong figure — or it is a count,
 * which should be a string here too so that the canonical form has exactly
 * one representation per value. `2` and `2.0` must not hash differently.
 */

export type Canonical =
  | string
  | boolean
  | null
  | readonly Canonical[]
  | { readonly [key: string]: Canonical | undefined };

export class NonCanonicalValue extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`Value at ${path || '<root>'} cannot be canonicalized: ${reason}`);
  }
}

/**
 * Produces the exact byte sequence that gets hashed.
 *
 * Exported because a test that only compares hashes tells you *that* two
 * things differ, never *how*. When the snapshot-immutability test fails,
 * the person reading the failure wants the canonical form.
 */
export function canonicalize(value: Canonical, path = ''): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (typeof value === 'number') {
    throw new NonCanonicalValue(
      path,
      'numbers are not permitted — money is a 3-decimal string and counts must be strings too, ' +
        'so that one value has exactly one canonical form',
    );
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, i) => canonicalize(item as Canonical, `${path}[${i}]`)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, Canonical | undefined>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v as Canonical, path ? `${path}.${k}` : k)}`)
      .join(',')}}`;
  }

  throw new NonCanonicalValue(path, `unsupported type ${typeof value}`);
}

/** SHA-256 over the canonical form, hex, prefixed with the algorithm. */
export function contentHash(value: Canonical): string {
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`;
}

/** Hash of a document's bytes, in the same shape as `contentHash`. */
export function documentHash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
