import { buildMismatches } from './documents.service';

/**
 * Extraction raw/corrected independence (ZM-DOC-006) — a phase
 * definition-of-done test.
 *
 *   "Both the original OCR output AND the supplier's corrections MUST be
 *    preserved and independently retrievable. A supplier correction MUST
 *    NOT erase the machine-extracted value."
 *
 * The structural guarantee is that the two live in different tables:
 * `document_extractions.raw_output` and `extracted_fields` hold what the
 * machine read, while the supplier's confirmed values live on `invoices`.
 * Nothing in DocumentsService updates a raw_output, so a correction cannot
 * reach it. What is testable purely is the join that brings the two
 * together on the way out, which is where they are compared without either
 * being overwritten.
 */

describe('the three-column comparison (ZM-DOC-006, ZM-DOC-008)', () => {
  const OCR = { faceValue: '24500.000', invoiceNumber: 'INV-2026-0002' };
  const QR = { faceValue: '25000.000', invoiceNumber: 'INV-2026-0002' };

  it('keeps the machine values alongside the supplier correction', () => {
    // The supplier corrected the total to 24500.000, agreeing with OCR and
    // disagreeing with the QR. All three values survive into the response.
    const mismatches = buildMismatches(OCR, QR, { faceValue: '24500.000' });

    expect(mismatches).toEqual([
      {
        field: 'faceValue',
        ocrValue: '24500.000',
        qrValue: '25000.000',
        userValue: '24500.000',
      },
    ]);
  });

  it('a correction that disagrees with both machines still preserves both', () => {
    const mismatches = buildMismatches(OCR, QR, { faceValue: '99999.000' });
    const faceValue = mismatches.find((m) => m.field === 'faceValue')!;

    expect(faceValue.ocrValue).toBe('24500.000');
    expect(faceValue.qrValue).toBe('25000.000');
    expect(faceValue.userValue).toBe('99999.000');
  });

  it('the seeded deliberate mismatch is reported even before the supplier types anything', () => {
    // At upload time there is no invoice yet, so the comparison has two
    // columns rather than three — and the OCR-vs-QR disagreement is already
    // visible, which is what lets the wizard highlight it during pre-fill.
    const mismatches = buildMismatches(OCR, QR, {});

    expect(mismatches).toEqual([
      { field: 'faceValue', ocrValue: '24500.000', qrValue: '25000.000' },
    ]);
  });

  it('reports nothing when every source agrees', () => {
    expect(
      buildMismatches({ faceValue: '100.000' }, { faceValue: '100.000' }, { faceValue: '100.000' }),
    ).toEqual([]);
  });

  it('a field only one source produced is not a mismatch', () => {
    // One reading being more complete than another is not a conflict, and
    // reporting it as one would bury the real conflicts.
    expect(buildMismatches({ purchaseOrderNumber: 'PO-1' }, {}, {})).toEqual([]);
  });

  it('a supplier value with no machine reading to contradict is not a mismatch', () => {
    expect(buildMismatches({}, {}, { goodsDescription: 'Bulk foodstuffs' })).toEqual([]);
  });

  it('reports every disagreeing field, sorted for a stable UI', () => {
    const mismatches = buildMismatches(
      { faceValue: '1.000', invoiceNumber: 'A', taxAmount: '1.000' },
      { faceValue: '2.000', invoiceNumber: 'B', taxAmount: '1.000' },
      {},
    );
    expect(mismatches.map((m) => m.field)).toEqual(['faceValue', 'invoiceNumber']);
  });

  it('ignores empty strings, which are absence rather than disagreement', () => {
    expect(buildMismatches({ faceValue: '' }, { faceValue: '25000.000' }, {})).toEqual([]);
  });
});
