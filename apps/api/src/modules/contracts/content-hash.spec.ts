import { NonCanonicalValue, canonicalize, contentHash, documentHash } from './content-hash';

/**
 * The hash is what makes ZM-SEL-008 checkable: a snapshot must remain
 * unchanged even if the source offer is later modified. A hash that moved
 * with irrelevant details — key order, an added `undefined` — would report
 * tampering that did not happen, and nobody would trust it by the third false
 * alarm.
 */

describe('canonicalization', () => {
  it('is insensitive to key order', () => {
    const a = { gross: '100.000', net: '90.000', bank: 'JNB' };
    const b = { bank: 'JNB', net: '90.000', gross: '100.000' };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('sorts nested keys too', () => {
    const a = { outer: { z: '1', a: '2' } };
    const b = { outer: { a: '2', z: '1' } };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it('preserves array order, because in a snapshot an array is ordered', () => {
    // Conditions carry a display order that is part of what was agreed.
    // Sorting them would make two genuinely different agreements hash alike.
    expect(contentHash({ c: ['a', 'b'] })).not.toBe(contentHash({ c: ['b', 'a'] }));
  });

  it('treats undefined and absent as the same thing, and null as a value', () => {
    expect(contentHash({ a: '1', b: undefined })).toBe(contentHash({ a: '1' }));
    expect(contentHash({ a: '1', b: null })).not.toBe(contentHash({ a: '1' }));
  });

  it('distinguishes a string from a differently-typed value', () => {
    expect(contentHash({ a: 'true' })).not.toBe(contentHash({ a: true }));
  });

  it('rejects numbers outright', () => {
    // The rule that matters most. A number here either came from money —
    // already imprecise — or is a count that should be a string so one value
    // has exactly one canonical form.
    expect(() => contentHash({ amount: 100.5 } as never)).toThrow(NonCanonicalValue);
  });

  it('names the path of the offending value', () => {
    try {
      contentHash({ terms: { conditions: [{ order: 1 }] } } as never);
      fail('expected a throw');
    } catch (err) {
      expect((err as NonCanonicalValue).path).toBe('terms.conditions[0].order');
    }
  });

  it('escapes strings so a value cannot forge structure', () => {
    // Without JSON.stringify on keys and values, `{"a":"1","b":"2"}` and a
    // single key containing a quote-comma-quote could canonicalize alike.
    expect(contentHash({ a: '1","b":"2' })).not.toBe(contentHash({ a: '1', b: '2' }));
  });
});

describe('contentHash', () => {
  it('is stable across calls', () => {
    const value = { a: '1', b: ['x', 'y'], c: { d: null } };
    expect(contentHash(value)).toBe(contentHash(value));
  });

  it('is prefixed with its algorithm', () => {
    expect(contentHash({ a: '1' })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changes when any value changes', () => {
    const before = contentHash({ net: '8390.000' });
    const after = contentHash({ net: '8390.001' });
    expect(before).not.toBe(after);
  });
});

describe('documentHash', () => {
  it('hashes bytes, and a single byte changes it', () => {
    const a = documentHash(Buffer.from('<article>terms</article>', 'utf8'));
    const b = documentHash(Buffer.from('<article>Terms</article>', 'utf8'));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
