import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { Money, MoneyString } from '../../common/money/money';
import { LedgerAccountKind } from './ledger.accounts';

/**
 * The double-entry ledger (ZM-FEE-016..019, INV-6).
 *
 * One rule governs this file: **a journal that does not balance is never
 * written.** Not written and flagged, not written and repaired later —
 * refused, so the imbalance cannot exist to be found. ZM-FEE-019 calls an
 * out-of-balance ledger a critical alert; the cheapest way to honour that is
 * to make the state unreachable through the only API that writes entries.
 *
 * Balance is checked with `Money` (decimal), never floats. Summing 8390.000
 * and 135.000 and 25.000 in IEEE doubles and comparing to 8550.000 is exactly
 * the kind of arithmetic that produces a 0.0000000001 imbalance and a
 * three-hour investigation.
 *
 * ## Append-only
 *
 * ZM-FEE-017: entries are immutable. The frozen schema enforces this with
 * `ledger_no_update` / `ledger_no_delete` RULEs, so a correction cannot be an
 * UPDATE even from raw SQL. Corrections are compensating entries — see
 * `reverse()`, which posts a mirror journal rather than touching the original.
 *
 * ## What the platform may claim to hold
 *
 * See `ledger.accounts.ts`. The gross funding never touches a platform cash
 * account because there is no such account: it pivots through
 * SETTLEMENT_CLEARING, and only commission and listing fees reach platform
 * revenue. That is ZM-FEE-018's "structurally obvious" distinction.
 */

export interface LedgerLine {
  entryType: 'DEBIT' | 'CREDIT';
  accountKind: LedgerAccountKind;
  amount: Money;
  /** Whose position this line represents. Null for platform-side accounts. */
  organizationId?: string | null;
  description: string;
  /** Set only by `reverse()`. */
  reversesEntryId?: string | null;
}

export interface JournalInput {
  lines: LedgerLine[];
  transactionId?: string | null;
  settlementId?: string | null;
}

export class LedgerImbalance extends Error {
  constructor(
    readonly debits: MoneyString,
    readonly credits: MoneyString,
  ) {
    super(
      `Refusing to post an unbalanced journal: debits ${debits} != credits ${credits}. ` +
        'Every journal must balance (INV-6, ZM-FEE-019).',
    );
    this.name = 'LedgerImbalance';
  }
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Post one balanced journal and return its id.
   *
   * Takes a `PoolClient` rather than opening its own transaction: a ledger
   * posting is never the whole of a financial operation. It belongs in the
   * same transaction as the settlement row or commission record it describes,
   * or a crash between the two leaves books that disagree with the facts they
   * are supposed to record.
   */
  async post(client: PoolClient, journal: JournalInput): Promise<string> {
    const { lines } = journal;
    if (lines.length < 2) {
      throw new Error(
        `A journal needs at least two lines to be double-entry; got ${lines.length}.`,
      );
    }

    this.assertBalanced(lines);

    const journalId = randomUUID();
    for (const line of lines) {
      if (!line.amount.isPositive()) {
        // The schema's CHECK (amount > 0) says the same thing; direction is
        // carried by entry_type, never by a negative amount. Two ways to
        // express "the other direction" is one way too many.
        throw new Error(
          `Ledger amounts must be positive; direction is DEBIT/CREDIT. Got ${line.amount.toString()}.`,
        );
      }

      await client.query(
        `INSERT INTO ledger_entries
           (journal_id, entry_type, account_kind, organization_id, amount, currency,
            transaction_id, settlement_id, description, reverses_entry_id)
         VALUES ($1,$2::ledger_entry_type,$3::ledger_account_kind,$4,$5::numeric,'JOD',$6,$7,$8,$9)`,
        [
          journalId,
          line.entryType,
          line.accountKind,
          line.organizationId ?? null,
          line.amount.toDb(),
          journal.transactionId ?? null,
          journal.settlementId ?? null,
          line.description,
          line.reversesEntryId ?? null,
        ],
      );
    }

    return journalId;
  }

  /**
   * Sum of debits must equal sum of credits, in decimal.
   *
   * Exported behaviour rather than an inline check because it is the single
   * assertion INV-6 rests on, and the test suite pins it directly.
   */
  assertBalanced(lines: LedgerLine[]): void {
    let debits = Money.zero();
    let credits = Money.zero();
    for (const line of lines) {
      if (line.entryType === 'DEBIT') debits = debits.add(line.amount);
      else credits = credits.add(line.amount);
    }
    if (!debits.equals(credits)) {
      throw new LedgerImbalance(debits.toString(), credits.toString());
    }
  }

  /**
   * Post the compensating mirror of an existing journal (ZM-FEE-017).
   *
   * Every line is re-posted with its direction flipped and a pointer back to
   * the entry it offsets. The original is left exactly as it was: the history
   * of what was believed at the time is the evidence, and a ledger that can be
   * rewritten is not evidence of anything.
   */
  async reverse(
    client: PoolClient,
    journalId: string,
    reason: string,
  ): Promise<string> {
    const { rows } = await client.query<{
      id: string;
      entry_type: 'DEBIT' | 'CREDIT';
      account_kind: LedgerAccountKind;
      organization_id: string | null;
      amount: string;
      transaction_id: string | null;
      settlement_id: string | null;
    }>(
      `SELECT id, entry_type, account_kind, organization_id, amount::text,
              transaction_id, settlement_id
         FROM ledger_entries WHERE journal_id = $1 ORDER BY created_at, id`,
      [journalId],
    );
    if (rows.length === 0) {
      throw new Error(`Cannot reverse journal ${journalId}: it has no entries.`);
    }

    const lines: LedgerLine[] = rows.map((row) => ({
      entryType: row.entry_type === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      accountKind: row.account_kind,
      organizationId: row.organization_id,
      amount: Money.from(row.amount),
      description: `Reversal: ${reason}`,
      reversesEntryId: row.id,
    }));

    return this.post(client, {
      lines,
      transactionId: rows[0].transaction_id,
      settlementId: rows[0].settlement_id,
    });
  }

  // ------------------------------------------------------------------
  // Reconciliation reads
  // ------------------------------------------------------------------

  /**
   * Every journal that does not balance.
   *
   * Should always be empty — `post()` makes writing one impossible through the
   * service. It exists because "impossible" is a claim about the code, and
   * ZM-FEE-019 wants the claim checked against the data: a row here means
   * something wrote entries by another route.
   */
  async unbalancedJournals(): Promise<{ journalId: string; difference: string }[]> {
    const { rows } = await this.db.query<{ journal_id: string; difference: string }>(
      `SELECT journal_id,
              (sum(amount) FILTER (WHERE entry_type = 'DEBIT')
               - sum(amount) FILTER (WHERE entry_type = 'CREDIT'))::text AS difference
         FROM ledger_entries
        GROUP BY journal_id
       HAVING coalesce(sum(amount) FILTER (WHERE entry_type = 'DEBIT'), 0)
            <> coalesce(sum(amount) FILTER (WHERE entry_type = 'CREDIT'), 0)`,
    );
    return rows.map((r) => ({ journalId: r.journal_id, difference: r.difference }));
  }

  /**
   * The net balance of one account kind for a transaction, debits positive.
   *
   * Used to assert that a completed settlement leaves SETTLEMENT_CLEARING at
   * zero — the check that the pass-through actually passed through rather than
   * quietly accumulating a balance the platform would appear to hold.
   */
  async accountBalance(
    accountKind: LedgerAccountKind,
    transactionId: string,
  ): Promise<Money> {
    const row = await this.db.queryOne<{ balance: string }>(
      `SELECT coalesce(
                sum(amount) FILTER (WHERE entry_type = 'DEBIT')
                - sum(amount) FILTER (WHERE entry_type = 'CREDIT'), 0)::text AS balance
         FROM ledger_entries
        WHERE account_kind = $1::ledger_account_kind AND transaction_id = $2`,
      [accountKind, transactionId],
    );
    return Money.from(normalizeScale(row?.balance ?? '0'));
  }

  async journalEntries(transactionId: string): Promise<
    {
      journalId: string;
      entryType: string;
      accountKind: string;
      amount: string;
      description: string;
      createdAt: Date;
    }[]
  > {
    const { rows } = await this.db.query<{
      journal_id: string;
      entry_type: string;
      account_kind: string;
      amount: string;
      description: string;
      created_at: Date;
    }>(
      `SELECT journal_id, entry_type, account_kind, amount::text, description, created_at
         FROM ledger_entries WHERE transaction_id = $1
        ORDER BY created_at, id`,
      [transactionId],
    );
    return rows.map((r) => ({
      journalId: r.journal_id,
      entryType: r.entry_type,
      accountKind: r.account_kind,
      amount: normalizeScale(r.amount),
      description: r.description,
      createdAt: r.created_at,
    }));
  }
}

/**
 * Postgres returns `numeric` sums without a fixed scale ("0", "8390.0"), while
 * `Money` requires exactly three decimals. Normalising here keeps every caller
 * from having to know that.
 */
function normalizeScale(value: string): string {
  const negative = value.startsWith('-');
  const bare = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = bare.split('.');
  return `${negative ? '-' : ''}${whole}.${fraction.padEnd(3, '0').slice(0, 3)}`;
}
