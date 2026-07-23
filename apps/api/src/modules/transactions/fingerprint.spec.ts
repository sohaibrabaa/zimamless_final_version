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

  describe('the seeded duplicate pair (the checkpoint scenario)', () => {
    /**
     * `INV-2026-0003-alnoor-aqaba-duplicate-a.pdf` and
     * `INV-2026-0003-petra-aqaba-duplicate-b.pdf` carry identical invoice
     * data — same buyer, number, date, value and tax — under two different
     * sellers. That is one receivable being claimed by two suppliers, the
     * single most expensive fraud this platform is exposed to, and the
     * fingerprint MUST collide on it.
     *
     * This is the case the v1 key got wrong: it included the submitting
     * supplier, so the second claimant hashed differently and reached
     * ELIGIBLE unblocked. `EINVOICE_QR.md` §7 always said this pair "must
     * collide on fingerprint"; the code disagreed with the spec until v2.
     */
    it('collides across two suppliers claiming the same receivable', () => {
      // The input carries no supplier at all — there is nothing to vary.
      // The equality is structural, which is the point: no future edit can
      // reintroduce a per-claimant key without this file failing to compile.
      const alnoorSubmission = { ...BASE };
      const petraSubmission = { ...BASE };
      expect(computeFingerprint(petraSubmission)).toBe(computeFingerprint(alnoorSubmission));
    });

    it('still matches when one supplier resubmits its own invoice', () => {
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
        'v2|30000203|INV20260003|2026-06-01|6960.000|960.000',
      );
    });

    it('is versioned, so the scheme can change without silently re-keying', () => {
      // v1 keyed on the submitting supplier as well. Bumping the version
      // means stored v1 digests cannot be mistaken for comparable values.
      expect(fingerprintSource(BASE).startsWith('v2|')).toBe(true);
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
