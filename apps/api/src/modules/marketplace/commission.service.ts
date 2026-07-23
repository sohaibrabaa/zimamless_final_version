import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';

/**
 * Platform commission (ZM-FEE-011).
 *
 * Two rules the requirement is precise about, and which the code makes hard
 * to get wrong:
 *
 *   1. **The basis is the gross funding amount, never the net.** Commission
 *      computed on the net would be circular — the net is defined as the
 *      gross minus the commission — and `commission_calculations.basis_amount`
 *      carries a schema comment saying "gross_funding_amount only".
 *   2. **The tier is the one active at calculation time.** Tiers are created,
 *      never edited (the same discipline as risk model versions), and a
 *      calculation cites the tier that priced it so the charge stays
 *      explainable after the tiers change.
 */

export interface CommissionTierRow {
  id: string;
  min_transaction_amount: string;
  max_transaction_amount: string | null;
  commission_percentage: string;
  fixed_commission_amount: string;
  fee_payer: 'SUPPLIER' | 'BANK' | 'SPLIT' | 'CUSTOM';
}

export interface CommissionQuote {
  readonly tierId: string;
  readonly amount: Money;
  readonly appliedPercentage: string;
  readonly appliedFixedAmount: Money;
  readonly feePayer: string;
}

@Injectable()
export class CommissionService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  /**
   * The tier covering `gross`, at the current (possibly demo-shifted) time.
   *
   * Bounds are **half-open** `[min, max)`: an amount of exactly 10 000 falls
   * in the second tier, not the first. Stated here, in the migration, and in
   * the tests, because an inclusive upper bound would make the two tiers
   * overlap at their shared boundary and the "cheapest first" ordering would
   * silently decide which one applied.
   */
  async tierFor(gross: Money, client?: PoolClient): Promise<CommissionTierRow> {
    const now = this.time.now();
    const sql = `
      SELECT * FROM commission_tiers
       WHERE is_active
         AND effective_from <= $1
         AND (effective_to IS NULL OR effective_to > $1)
         AND min_transaction_amount <= $2::numeric
         AND (max_transaction_amount IS NULL OR max_transaction_amount > $2::numeric)
       ORDER BY min_transaction_amount DESC
       LIMIT 1`;
    const params = [now, gross.toDb()];

    const row = client
      ? ((await client.query<CommissionTierRow>(sql, params)).rows[0] ?? null)
      : await this.db.queryOne<CommissionTierRow>(sql, params);

    if (!row) {
      // Refusing beats charging zero. A missing tier is a configuration
      // failure, and a silently free transaction is the kind of thing nobody
      // notices until the month-end reconciliation.
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'No active commission tier covers this amount.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return row;
  }

  /**
   * Quotes the commission on a gross amount.
   *
   * `percentOf` and the addition are decimal throughout — the percentage is
   * `numeric(7,5)`, so 1.25% is `1.25000`, and turning that into a JS number
   * on the way past would be exactly the defect hard rule 2 names.
   */
  async quote(gross: Money, client?: PoolClient): Promise<CommissionQuote> {
    const tier = await this.tierFor(gross, client);
    const percentagePart = gross.percentOf(tier.commission_percentage);
    const fixedPart = Money.from(tier.fixed_commission_amount);

    return {
      tierId: tier.id,
      amount: percentagePart.add(fixedPart).round(),
      appliedPercentage: tier.commission_percentage,
      appliedFixedAmount: fixedPart,
      feePayer: tier.fee_payer,
    };
  }

  /**
   * Records the calculation against a transaction.
   *
   * Written at offer *acceptance* rather than at offer creation — a quote on
   * an offer nobody selected is not a charge, and writing one per draft offer
   * would fill the table with rows that never become money. Phase 5 quotes;
   * Phase 6 records. The method lives here so the caller in Phase 6 does not
   * reimplement the arithmetic.
   */
  async record(
    client: PoolClient,
    input: { transactionId: string; gross: Money; quote: CommissionQuote },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO commission_calculations
         (transaction_id, tier_id, basis_amount, applied_percentage,
          applied_fixed_amount, commission_amount, fee_payer, status, calculated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'CALCULATED',$8)
       RETURNING id`,
      [
        input.transactionId,
        input.quote.tierId,
        input.gross.toDb(),
        input.quote.appliedPercentage,
        input.quote.appliedFixedAmount.toDb(),
        input.quote.amount.toDb(),
        input.quote.feePayer,
        this.time.now(),
      ],
    );
    return rows[0].id;
  }
}
