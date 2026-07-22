import { Decimal } from 'decimal.js';
import { Money, MoneyError } from './money';

/**
 * Money precision (Master Plan 5.5). Float arithmetic on money is a defect,
 * always — these tests make that mechanical rather than a matter of
 * reviewer discipline.
 */
describe('Money', () => {
  describe('parsing', () => {
    it('accepts a 3-dp decimal string', () => {
      expect(Money.from('1250.000').toString()).toBe('1250.000');
    });

    it('refuses a JavaScript number outright', () => {
      // The lint rule can be silenced with a disable comment; this cannot.
      // A money value that is already a number may have lost precision
      // before any code here runs, so the type is rejected at the boundary.
      expect(() => Money.from(1250.5 as unknown as string)).toThrow(MoneyError);
      expect(() => Money.from(1250.5 as unknown as string)).toThrow(/number/i);
    });

    it('refuses strings that are not exactly 3 dp', () => {
      // Deliberately strict: "1250" and "1250.5" are how a caller that
      // round-tripped through a float would present a value, so accepting
      // them would hide exactly the bug this class exists to prevent.
      for (const bad of ['1250', '1250.5', '1250.00', '1250.0000']) {
        expect(() => Money.from(bad)).toThrow(MoneyError);
      }
    });

    it('rejects malformed input rather than coercing it', () => {
      for (const bad of ['', 'abc', '1,250.000', '1250.000abc', null, undefined, {}]) {
        expect(() => Money.from(bad as unknown as string)).toThrow(MoneyError);
      }
    });

    it('accepts a Decimal or another Money unchanged', () => {
      expect(Money.from(new Decimal('1250.0004')).toString()).toBe('1250.000');
      expect(Money.from(Money.from('1250.000')).toString()).toBe('1250.000');
    });
  });

  describe('fromDb', () => {
    it('reads what numeric(18,3) returns', () => {
      expect(Money.fromDb('1250.000')!.toString()).toBe('1250.000');
    });

    it('tolerates a scale the column did not fix', () => {
      expect(Money.fromDb('1250')!.toString()).toBe('1250.000');
      expect(Money.fromDb('1250.5')!.toString()).toBe('1250.500');
    });

    it('maps NULL to null, not zero', () => {
      // An absent amount and a zero amount are different facts; collapsing
      // them would silently turn "no commission recorded" into "no
      // commission owed".
      expect(Money.fromDb(null)).toBeNull();
      expect(Money.fromDb(undefined)).toBeNull();
      expect(Money.fromDb('0.000')!.isZero()).toBe(true);
    });
  });

  describe('precision', () => {
    it('survives the classic float-error case', () => {
      // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754.
      expect(Money.from('0.100').add(Money.from('0.200')).toString()).toBe('0.300');
    });

    it('preserves the smallest representable amount', () => {
      expect(Money.from('0.001').toString()).toBe('0.001');
    });

    it('preserves trailing zeros — 1250.000 must not become 1250', () => {
      expect(Money.from('1250.000').toString()).toBe('1250.000');
    });

    it('handles the numeric(18,3) ceiling without scientific notation', () => {
      const max = '999999999999999.999';
      expect(Money.from(max).toString()).toBe(max);
    });

    it('does not drift across a long accumulation', () => {
      let total = Money.zero();
      for (let i = 0; i < 1000; i++) total = total.add(Money.from('0.001'));
      expect(total.toString()).toBe('1.000');
    });
  });

  describe('rounding', () => {
    it('rounds half away from zero at three places', () => {
      // Fixed once here and referenced by ARCHITECTURE.md. Banker's rounding
      // would make chk_settlement_split fail intermittently, because the DB
      // and the service would disagree on the half case.
      expect(Money.from(new Decimal('100.0005')).toString()).toBe('100.001');
      expect(Money.from(new Decimal('100.0004')).toString()).toBe('100.000');
    });

    it('computes the adversarial commission case deterministically', () => {
      // Commission on gross 100.005 at 1.25% — Master Plan 5.5.
      expect(Money.from('100.005').percentOf('1.25').toString()).toBe('1.250');
    });

    it('percentOf divides by 100 rather than treating the rate as a factor', () => {
      expect(Money.from('10000.000').percentOf('1.25').toString()).toBe('125.000');
    });
  });

  describe('arithmetic', () => {
    it('adds, subtracts, and multiplies without float error', () => {
      expect(Money.from('1000.000').subtract(Money.from('12.345')).toString()).toBe('987.655');
      expect(Money.from('1000.000').multiply('3').toString()).toBe('3000.000');
    });

    it('multiplies by a safe-integer count', () => {
      // A count of instalments is exact as a JS number; nothing is lost.
      expect(Money.from('1000.000').multiply(3).toString()).toBe('3000.000');
    });

    it('refuses a fractional JS number factor', () => {
      // The float ban is not cosmetic: 0.1 has already lost precision by the
      // time multiply() sees it, exactly as with Money.from(0.1).
      expect(() => Money.from('1000.000').multiply(0.1)).toThrow(TypeError);
      expect(() => Money.from('1000.000').multiply(1.25)).toThrow(/safe integers/);
    });

    it('accepts a fractional factor as a string', () => {
      expect(Money.from('1000.000').multiply('0.1').toString()).toBe('100.000');
    });

    it('computes the net-payout formula exactly as the DB CHECK does', () => {
      // chk_net_formula: net = gross - discount - fees - commission - listingFee - other
      const net = Money.from('10000.000')
        .subtract(Money.from('250.500'))
        .subtract(Money.from('75.250'))
        .subtract(Money.from('125.000'))
        .subtract(Money.from('25.000'))
        .subtract(Money.from('0.001'));
      expect(net.toString()).toBe('9524.249');
    });

    it('reports sign correctly', () => {
      expect(Money.from('-1.000').isNegative()).toBe(true);
      expect(Money.zero().isZero()).toBe(true);
      expect(Money.from('0.001').isPositive()).toBe(true);
      expect(Money.zero().isPositive()).toBe(false);
    });
  });

  describe('comparison', () => {
    it('compares by value', () => {
      expect(Money.from('1250.000').equals(Money.fromDb('1250')!)).toBe(true);
      expect(Money.from('100.000').lessThan(Money.from('100.001'))).toBe(true);
    });

    it('resolves the INV-2 boundary exactly', () => {
      // net == floor must pass; floor - 0.001 must fail. A float comparison
      // is not reliable at this boundary, which is the entire point.
      const floor = Money.from('9524.249');
      expect(Money.from('9524.249').greaterThanOrEqual(floor)).toBe(true);
      expect(Money.from('9524.250').greaterThanOrEqual(floor)).toBe(true);
      expect(Money.from('9524.248').greaterThanOrEqual(floor)).toBe(false);
    });
  });

  describe('serialization', () => {
    const CONTRACT_MONEY_PATTERN = /^-?\d+\.\d{3}$/;

    it('always matches the contract Money pattern', () => {
      for (const v of ['0.001', '1250.000', '999999999999999.999', '0.000', '-1.000']) {
        expect(Money.from(v).toString()).toMatch(CONTRACT_MONEY_PATTERN);
      }
    });

    it('serializes as a string through JSON, never as a number', () => {
      // The failure this guards against is a response body containing
      // "amount": 1250 — valid JSON, silently lossy, and a contract
      // violation that no type checker would catch.
      expect(JSON.stringify({ amount: Money.from('1250.000') })).toBe('{"amount":"1250.000"}');
    });

    it('round-trips wire -> Money -> wire unchanged', () => {
      for (const v of ['0.001', '1250.000', '999999999999999.999']) {
        expect(Money.from(v).toDb()).toBe(v);
      }
    });
  });

  describe('isValidMoneyString', () => {
    it('accepts only the contract form', () => {
      expect(Money.isValidMoneyString('1250.000')).toBe(true);
      expect(Money.isValidMoneyString('1250')).toBe(false);
      expect(Money.isValidMoneyString(1250)).toBe(false);
      expect(Money.isValidMoneyString(null)).toBe(false);
    });
  });
});
