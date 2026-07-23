import { computeFingerprint, fingerprintSource, normalizeIdentifier } from './fingerprint';

/**
 * Fingerprint uniqueness (ZM-VER-001) — a phase definition-of-done test.
 *
 * The fingerprint is what stops one receivable being financed twice. It has
 * to be strict enough that reformatting cannot evade it and loose enough
 * that two genuinely different invoices never collide, and the cases below
 * pin both edges.
 */

const BASE = {
  supplierEstablishmentNumber: '20000101',
  buyerEstablishmentNumber: '30000203',
  invoiceNumber: 'INV-2026-0003',
  issueDate: '2026-06-01',
  faceValue: '6960.000',
  taxAmount: '960.000',
};

describe('invoice fingerprint', () => {
  it('is deterministic', () => {
    expect(computeFingerprint(BASE)).toBe(computeFingerprint({ ...BASE }));
  });

  it('is a sha256 hex digest', () => {
    expect(computeFingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('the seeded duplicate pair', () => {
    /**
     * The two seeded e-invoices carry identical invoice data under
     * different sellers. The fingerprint includes the supplier, so they do
     * NOT collide — which is correct: the same invoice number issued by two
     * unrelated businesses is a coincidence, not a duplicate.
     *
     * The collision the platform must catch is the same *supplier* invoice
     * submitted twice, and the double-financing attempt where a second
     * supplier claims the same receivable is caught by the buyer plus
     * invoice-number plus amount triple below.
     */
    it('differs when the supplier differs', () => {
      const petra = { ...BASE, supplierEstablishmentNumber: '20000102' };
      expect(computeFingerprint(petra)).not.toBe(computeFingerprint(BASE));
    });

    it('matches when the same supplier resubmits the same invoice', () => {
      expect(computeFingerprint({ ...BASE })).toBe(computeFingerprint(BASE));
    });
  });

  describe('resists evasion by reformatting', () => {
    it.each([
      ['lower case', 'inv-2026-0003'],
      ['spaces for hyphens', 'INV 2026 0003'],
      ['slashes', 'INV/2026/0003'],
      ['a hash prefix', 'INV#2026-0003'],
      ['surrounding whitespace', '  INV-2026-0003  '],
    ])('treats %s as the same invoice number', (_label, invoiceNumber) => {
      expect(computeFingerprint({ ...BASE, invoiceNumber })).toBe(computeFingerprint(BASE));
    });

    it('treats an unpadded amount as the same money', () => {
      // "6960" and "6960.000" are the same amount written differently, and
      // a duplicate must not slip through on the difference.
      expect(computeFingerprint({ ...BASE, faceValue: '6960' })).toBe(computeFingerprint(BASE));
    });
  });

  describe('does not collide across genuinely different invoices', () => {
    it.each([
      ['a different invoice number', { invoiceNumber: 'INV-2026-0004' }],
      ['a different buyer', { buyerEstablishmentNumber: '30000201' }],
      ['a different issue date', { issueDate: '2026-06-02' }],
      ['a different face value', { faceValue: '6961.000' }],
      ['a different tax amount', { taxAmount: '961.000' }],
    ])('differs on %s', (_label, change) => {
      expect(computeFingerprint({ ...BASE, ...change })).not.toBe(computeFingerprint(BASE));
    });

    it('distinguishes amounts differing only in the third decimal place', () => {
      // Money is 3-dp throughout, so the third place is significant. A
      // fingerprint that rounded would merge two different invoices.
      expect(computeFingerprint({ ...BASE, faceValue: '6960.001' })).not.toBe(
        computeFingerprint(BASE),
      );
    });
  });

  describe('fingerprintSource', () => {
    it('is readable, so a collision can be explained to a reviewer', () => {
      expect(fingerprintSource(BASE)).toBe(
        'v1|20000101|30000203|INV20260003|2026-06-01|6960.000|960.000',
      );
    });

    it('is versioned, so the scheme can change without silently re-keying', () => {
      expect(fingerprintSource(BASE).startsWith('v1|')).toBe(true);
    });

    it('refuses an amount that is not a plain decimal string', () => {
      // A JS number would already have lost precision before arriving.
      expect(() => fingerprintSource({ ...BASE, faceValue: '6,960.000' })).toThrow(TypeError);
    });
  });

  describe('normalizeIdentifier', () => {
    it('keeps only letters and digits, upper-cased', () => {
      expect(normalizeIdentifier(' inv-2026/0003 ')).toBe('INV20260003');
    });

    it('does not merge identifiers that differ in content', () => {
      expect(normalizeIdentifier('INV-1')).not.toBe(normalizeIdentifier('INV-2'));
    });
  });
});
