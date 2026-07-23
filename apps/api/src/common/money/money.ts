import { Decimal } from 'decimal.js';

/**
 * Money — the only sanctioned way to hold or compute a monetary value.
 *
 * The contract's rule 3 and the schema agree: numeric(18,3) in the database,
 * a decimal type in code, and a 3-dp string on the wire. Never a JSON number.
 * `MoneyString` is that wire form and matches the contract's Money schema
 * pattern `^-?\d+\.\d{3}$` exactly.
 *
 * Rounding is defined once, here, and referenced by ARCHITECTURE.md:
 * HALF_UP at 3 decimal places. Commission calculation, offer validation, and
 * settlement splits all round through this class, so the DB CHECK
 * (chk_net_formula, chk_settlement_split), the service computation, and the
 * API string cannot disagree.
 */

/** A monetary value as it appears on the wire: exactly 3 decimal places. */
export type MoneyString = string;

const SCALE = 3;

// decimal.js is configured process-wide. HALF_UP ("round half away from
// zero") is decimal.js ROUND_HALF_UP = 4. Precision is generous enough for
// numeric(18,3) intermediates without ever needing scientific notation.
Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

/**
 * The wire format, exported so DTO validators match on the same expression
 * this class parses with.
 *
 * A second copy of this regex living in a DTO file is how "the API rejected
 * it but Money would have accepted it" starts — the two drift, and the
 * mismatch surfaces as a 500 from deep inside a service instead of a 422 at
 * the edge naming the field.
 */
export const MONEY_PATTERN = /^-?\d+\.\d{3}$/;

export const MONEY_MESSAGE =
  'must be a decimal string with exactly 3 decimal places, e.g. "1250.000"';

export class MoneyError extends Error {}

export class Money {
  private constructor(private readonly value: Decimal) {}

  /**
   * Parse a value that is already known to be money.
   *
   * Accepts a 3-dp string (the wire and DB form), a Decimal, or another
   * Money. It deliberately does NOT accept a JavaScript number: by the time
   * a money value is a number it may already have lost precision, and
   * accepting it here would make the lint ban cosmetic.
   */
  static from(input: MoneyString | Decimal | Money): Money {
    if (input instanceof Money) return input;
    if (input instanceof Decimal) return new Money(input.toDecimalPlaces(SCALE));

    if (typeof input !== 'string') {
      throw new MoneyError(
        `Money must be a 3-dp string, Decimal, or Money — got ${typeof input}. ` +
          'A JavaScript number may already have lost precision; if this came from ' +
          'JSON, the producer is violating contract rule 3.',
      );
    }
    const trimmed = input.trim();
    if (!MONEY_PATTERN.test(trimmed)) {
      throw new MoneyError(
        `Malformed money string "${input}". Expected exactly 3 decimal places, e.g. "1250.000".`,
      );
    }
    return new Money(new Decimal(trimmed));
  }

  /**
   * Parse a value from Postgres. node-postgres returns numeric as a string
   * to avoid exactly the precision loss we are guarding against, but the
   * scale it returns follows the column, so "1250.000" is what arrives from
   * numeric(18,3). NULL maps to null rather than zero — an absent amount and
   * a zero amount are different facts.
   */
  static fromDb(input: string | null | undefined): Money | null {
    if (input === null || input === undefined) return null;
    return new Money(new Decimal(input).toDecimalPlaces(SCALE));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  static isValidMoneyString(input: unknown): input is MoneyString {
    return typeof input === 'string' && MONEY_PATTERN.test(input.trim());
  }

  add(other: Money): Money {
    return new Money(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    return new Money(this.value.minus(other.value));
  }

  /**
   * Multiply by a dimensionless factor (a rate, a quantity).
   *
   * A JS `number` is accepted only when it is a safe integer — a count of
   * invoices or instalments, which cannot carry a fractional-binary error.
   * A fractional number (0.1, a rate read from JSON) is rejected for the same
   * reason `from()` rejects one: by the time it arrives the precision is
   * already gone. Pass rates as strings or Decimals.
   */
  multiply(factor: Decimal | string | number): Money {
    if (typeof factor === 'number' && !Number.isSafeInteger(factor)) {
      throw new TypeError(
        `Money.multiply() refuses the JS number ${factor}: only safe integers are exact. ` +
          `Pass a string or Decimal for any fractional factor.`,
      );
    }
    return new Money(this.value.times(new Decimal(factor)).toDecimalPlaces(SCALE));
  }

  /** Apply a percentage, e.g. commission at 1.25 → percent("1.25"). */
  percentOf(percentage: Decimal | string): Money {
    return new Money(this.value.times(new Decimal(percentage)).dividedBy(100).toDecimalPlaces(SCALE));
  }

  /** Explicit HALF_UP rounding to 3 dp. Arithmetic above already rounds. */
  round(): Money {
    return new Money(this.value.toDecimalPlaces(SCALE));
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  greaterThanOrEqual(other: Money): boolean {
    return this.value.greaterThanOrEqualTo(other.value);
  }

  lessThan(other: Money): boolean {
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.value.equals(other.value);
  }

  /** The wire form. Always exactly 3 decimal places. */
  toString(): MoneyString {
    return this.value.toFixed(SCALE);
  }

  /** Serialized as the 3-dp string, so JSON.stringify is safe by default. */
  toJSON(): MoneyString {
    return this.toString();
  }

  /** The DB form — identical to the wire form for numeric(18,3). */
  toDb(): string {
    return this.toString();
  }

  /**
   * Escape hatch for callers that genuinely need the underlying decimal
   * (property tests, formula verification). Returns a copy.
   */
  toDecimal(): Decimal {
    return new Decimal(this.value);
  }
}
