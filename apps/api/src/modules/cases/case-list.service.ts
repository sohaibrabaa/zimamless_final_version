import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * The unified case list (`GET /cases`, v3.1.0 overlay).
 *
 * Four case types in one list — fraud, disputes, withdrawal, recourse — with
 * one rule about who sees what:
 *
 *   **Platform sees all. A bank or supplier sees only cases on its own
 *   transactions, minus confidential counterpart data.**
 *
 * Two consequences worth stating, because both are the kind of thing a
 * "just join everything" implementation gets wrong:
 *
 * **Fraud cases are platform-only, full stop.** They are excluded from a
 * bank's and a supplier's list entirely rather than shown with fields
 * redacted. A supplier learning that *a fraud case exists* naming them, before
 * compliance has concluded anything, is the disclosure — the fields are
 * incidental. This mirrors `FraudService.findById`, which 404s the same
 * parties.
 *
 * **A counterparty's free text never appears in a summary.** The list carries
 * a type, a status, an amount and a date. It does not carry the bank's
 * `reason_notes` on a recourse claim or the platform's `admin_decision_notes`
 * on a withdrawal, because a list view is exactly where such a field gets
 * rendered without anyone thinking about who is reading.
 */

export type CaseType = 'FRAUD' | 'DISPUTE' | 'WITHDRAWAL' | 'RECOURSE';

export interface CaseSummary {
  id: string;
  type: CaseType;
  transactionId: string | null;
  status: string;
  amount: string | null;
  openedAt: string;
}

@Injectable()
export class CaseListService {
  constructor(private readonly db: DatabaseService) {}

  async list(
    ctx: ActorContext,
    filters: { type?: CaseType; status?: string; page: number; pageSize: number },
  ): Promise<Record<string, unknown>> {
    const isPlatform = ctx.organizationType === 'PLATFORM';

    // Each case type contributes a uniform shape, so they can be paged as one
    // list. `visibility` is applied per type because "my transactions" means a
    // different join for a bank than for a supplier.
    const parts: string[] = [];
    // The org id is only bound for a non-platform caller, because the platform
    // branches use a literal `true` and never reference it. Passing a
    // parameter no branch mentions is a bind-count error, not a harmless extra.
    const params: unknown[] = isPlatform ? [] : [ctx.organizationId];

    const wants = (type: CaseType) => !filters.type || filters.type === type;

    if (wants('RECOURSE')) {
      parts.push(`
        SELECT r.id, 'RECOURSE' AS type, r.transaction_id, r.status::text AS status,
               r.remaining_amount::text AS amount, r.initiated_at AS opened_at
          FROM recourse_cases r
          JOIN receivable_transactions t ON t.id = r.transaction_id
          LEFT JOIN accepted_offer_snapshots s ON s.transaction_id = t.id
         WHERE ${isPlatform ? 'true' : '(t.supplier_org_id = $1 OR s.bank_org_id = $1)'}`);
    }

    if (wants('DISPUTE')) {
      parts.push(`
        SELECT d.id, 'DISPUTE' AS type, d.transaction_id, d.status::text AS status,
               d.amount::text AS amount, d.raised_at AS opened_at
          FROM disputes d
          JOIN receivable_transactions t ON t.id = d.transaction_id
          LEFT JOIN accepted_offer_snapshots s ON s.transaction_id = t.id
         WHERE ${isPlatform ? 'true' : '(t.supplier_org_id = $1 OR s.bank_org_id = $1)'}`);
    }

    if (wants('WITHDRAWAL')) {
      parts.push(`
        SELECT w.id, 'WITHDRAWAL' AS type, w.transaction_id, w.status::text AS status,
               w.penalty_amount::text AS amount, w.requested_at AS opened_at
          FROM withdrawal_cases w
          JOIN receivable_transactions t ON t.id = w.transaction_id
         WHERE ${isPlatform ? 'true' : '(t.supplier_org_id = $1 OR w.bank_org_id = $1)'}`);
    }

    // Fraud: platform only, and omitted from the query entirely for anyone
    // else rather than filtered afterwards. A case that never enters the
    // result set cannot be leaked by a later bug in pagination or serialization.
    if (wants('FRAUD') && isPlatform) {
      parts.push(`
        SELECT f.id, 'FRAUD' AS type, f.transaction_id, f.status::text AS status,
               NULL::text AS amount, f.opened_at
          FROM fraud_cases f`);
    }

    if (parts.length === 0) {
      return {
        items: [],
        pagination: { page: filters.page, pageSize: filters.pageSize, total: 0, totalPages: 1 },
      };
    }

    const union = parts.join('\n UNION ALL \n');
    const statusFilter = filters.status ? `WHERE c.status = $${params.length + 1}` : '';
    if (filters.status) params.push(filters.status);

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM (${union}) c ${statusFilter}`,
      params,
    );

    params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const { rows } = await this.db.query<{
      id: string;
      type: CaseType;
      transaction_id: string | null;
      status: string;
      amount: string | null;
      opened_at: Date;
    }>(
      `SELECT * FROM (${union}) c ${statusFilter}
        ORDER BY opened_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const total = Number(totalRow?.count ?? '0');
    return {
      items: rows.map(
        (row): CaseSummary => ({
          id: row.id,
          type: row.type,
          transactionId: row.transaction_id,
          status: row.status,
          amount: row.amount,
          openedAt: row.opened_at.toISOString(),
        }),
      ),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize) || 1,
      },
    };
  }
}
