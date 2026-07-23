import { Money } from '../../common/money/money';
import { meetsFloor, netPayoutOf, validateOffer } from './offer-math';

const m = (s: string): Money => Money.from(s);

const components = (over: Partial<Record<string, string>> = {}) => ({
  grossFundingAmount: m(over.gross ?? '10000.000'),
  bankDiscountAmount: m(over.discount ?? '300.000'),
  bankFeesAmount: m(over.fees ?? '150.000'),
  platformCommissionAmount: m(over.commission ?? '100.000'),
  listingFeeAmount: m(over.listingFee ?? '25.000'),
  otherDeductionsAmount: m(over.other ?? '0.000'),
});

describe('the net formula (ZM-OFR-002)', () => {
  it('subtracts every deduction from gross', () => {
    // 10000 − 300 − 150 − 100 − 25 − 0
    expect(netPayoutOf(components()).toString()).toBe('9425.000');
  });

  it('matches the database CHECK constraint expression', () => {
    // Two places compute this; if they ever disagree the database refuses the
    // insert. This test is the cheap half of that pair.
    const c = components({ other: '75.500' });
    const expected = m('10000.000')
      .subtract(m('300.000')).subtract(m('150.000'))
      .subtract(m('100.000')).subtract(m('25.000')).subtract(m('75.500'));
    expect(netPayoutOf(c).toString()).toBe(expected.toString());
  });

  it('keeps three decimal places exactly', () => {
    // 10000.001 − 0.002 − 150 − 100 − 25 − 0
    const c = components({ gross: '10000.001', discount: '0.002' });
    expect(netPayoutOf(c).toString()).toBe('9724.999');
  });

  it('does not accumulate binary floating-point error', () => {
    // The canonical demonstration: 0.1 + 0.2 !== 0.3 in float. Money is
    // decimal, so a hundred tenth-JOD deductions must land exactly.
    let net = m('100.000');
    for (let i = 0; i < 100; i += 1) net = net.subtract(m('0.100'));
    expect(net.toString()).toBe('90.000');
  });
});

describe('validateOffer', () => {
  const outstanding = m('12354.000');

  it('accepts a well-formed offer', () => {
    const result = validateOffer(components(), outstanding);
    expect(result.ok).toBe(true);
    expect(result.net.toString()).toBe('9425.000');
  });

  it('rejects gross above the outstanding amount', () => {
    const result = validateOffer(components({ gross: '12354.001' }), outstanding);
    expect(result.rejection).toBe('GROSS_EXCEEDS_OUTSTANDING');
  });

  it('accepts gross exactly equal to the outstanding amount', () => {
    // The boundary is inclusive: financing the whole receivable is normal.
    const result = validateOffer(
      components({ gross: '12354.000' }), outstanding,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a non-positive gross', () => {
    expect(validateOffer(components({ gross: '0.000' }), outstanding).rejection)
      .toBe('GROSS_NOT_POSITIVE');
  });

  it('rejects deductions that exceed the gross', () => {
    const result = validateOffer(components({ discount: '9999.000' }), outstanding);
    expect(result.rejection).toBe('NET_NOT_POSITIVE');
  });

  it('rejects a negative deduction', () => {
    // A negative "deduction" is a bank quietly increasing the net past what
    // its own gross says it is funding.
    expect(validateOffer(components({ fees: '-50.000' }), outstanding).rejection)
      .toBe('DEDUCTIONS_NEGATIVE');
  });

  it('rejects a client net that disagrees with the server’s', () => {
    // Reject, never silently correct: a bank whose UI computed a different
    // net would otherwise believe it offered one number while the supplier
    // sees another.
    const result = validateOffer(components(), outstanding, m('9500.000'));
    expect(result.rejection).toBe('NET_MISMATCH');
  });

  it('accepts a client net that agrees exactly', () => {
    expect(validateOffer(components(), outstanding, m('9425.000')).ok).toBe(true);
  });

  it('rejects a client net that differs by one thousandth', () => {
    // The smallest representable disagreement still counts. Rounding a
    // fils away is how reconciliation breaks three phases later.
    expect(validateOffer(components(), outstanding, m('9425.001')).rejection)
      .toBe('NET_MISMATCH');
  });
});

describe('meetsFloor (ZM-MKT-012)', () => {
  it('passes when the net clears the floor', () => {
    expect(meetsFloor(m('9425.000'), m('9000.000'))).toBe(true);
  });

  it('passes at exactly the floor', () => {
    // The floor is a minimum the supplier will accept, not one they must beat.
    expect(meetsFloor(m('9000.000'), m('9000.000'))).toBe(true);
  });

  it('fails one thousandth below the floor', () => {
    expect(meetsFloor(m('8999.999'), m('9000.000'))).toBe(false);
  });

  it('passes when no floor is set', () => {
    expect(meetsFloor(m('1.000'), null)).toBe(true);
  });

  it('returns only a boolean — no shortfall is ever computed', () => {
    // INV-8 made structural. The function's return type is the guarantee:
    // there is no difference, percentage or gap for a caller to leak,
    // because none is produced.
    const result = meetsFloor(m('100.000'), m('9000.000'));
    expect(typeof result).toBe('boolean');
  });
});
