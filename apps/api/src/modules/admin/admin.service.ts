import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../common/audit/audit.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { Money } from '../../common/money/money';
import { SystemTimeProvider } from '../../common/time/time.provider';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Settings that hold an amount of money. Whitelisting the *keys* is not
 * enough for these: `Money`'s wire pattern accepts a negative, and a negative
 * listing fee frozen into an obligation would flow through funding math as a
 * payout bonus. Validated here, at the only door these values enter through.
 */
const MONEY_SETTINGS = new Set(['listing_fee_amount']);

/**
 * The platform admin surface (requirements §16 admin).
 *
 * Settings, commission tiers, the relisting review decision, and the audit
 * trail — the last of which is where every mutation this system has recorded
 * since Phase 1 finally becomes readable by the people accountable for it.
 *
 * Everything here is platform-only at the controller; the service assumes that
 * guard has already run and concerns itself with the data rules.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly time: SystemTimeProvider,
  ) {}

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------

  /** Every platform setting as a flat `{ key: value }` object. */
  async getSettings(): Promise<Record<string, unknown>> {
    const { rows } = await this.db.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM platform_settings ORDER BY key`,
    );
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = row.value;
    return out;
  }

  /**
   * Update settings by key.
   *
   * Only keys that already exist may be written — a PATCH is for changing
   * configuration, not inventing it, and an unknown key is far more likely a
   * typo that would sit silently unread than a deliberate new setting. Each
   * changed key is audited with its old and new value, because a settings
   * change (the maturity reminder days, the time-machine arming) moves system
   * behaviour and must be attributable.
   */
  async patchSettings(
    patch: Record<string, unknown>,
    ctx: ActorContext,
  ): Promise<Record<string, unknown>> {
    const keys = Object.keys(patch);
    if (keys.length === 0) throw AppException.validation('No settings to update.');

    for (const key of keys) {
      if (!MONEY_SETTINGS.has(key)) continue;
      const value = patch[key];
      if (
        typeof value !== 'string' ||
        !Money.isValidMoneyString(value) ||
        Money.from(value).isNegative()
      ) {
        throw AppException.validation(
          `"${key}" must be a non-negative amount as a 3-decimal string.`,
          { key },
        );
      }
    }

    const settings = await this.db.transaction(async (client) => {
      for (const key of keys) {
        const { rows } = await client.query<{ value: unknown }>(
          `SELECT value FROM platform_settings WHERE key = $1 FOR UPDATE`,
          [key],
        );
        if (rows.length === 0) {
          throw AppException.validation(`Unknown setting "${key}".`, { key });
        }
        const previous = rows[0].value;
        await client.query(
          `UPDATE platform_settings SET value = $2::jsonb, updated_by = $3::uuid, updated_at = now()
            WHERE key = $1`,
          [key, JSON.stringify(patch[key]), ctx.userId],
        );
        await this.audit.recordIn(client, {
          actionType: 'PLATFORM_SETTING_UPDATED',
          targetEntityType: 'PLATFORM_SETTING',
          targetEntityId: null,
          previousValue: { key, value: previous },
          newValue: { key, value: patch[key] },
        });
      }
      const { rows } = await client.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM platform_settings ORDER BY key`,
      );
      const out: Record<string, unknown> = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    });

    // Disarming (or arming) the time machine must reach the clock's cache
    // now, not whenever the next /auth/me happens to refresh it — the sweeps
    // run on this cache, and a disarm that leaves them on a +45d clock for
    // an unbounded time is a disarm in name only.
    if (keys.includes('demo_time_machine_enabled')) {
      await this.time.refresh();
    }

    return settings;
  }

  // ---------------------------------------------------------------
  // Commission tiers
  // ---------------------------------------------------------------

  async getCommissionTiers(): Promise<Record<string, unknown>[]> {
    const { rows } = await this.db.query<CommissionTierRow>(
      `SELECT id, min_transaction_amount::text, max_transaction_amount::text,
              commission_percentage, fixed_commission_amount::text, fee_payer,
              effective_from, is_active
         FROM commission_tiers ORDER BY effective_from DESC, min_transaction_amount`,
    );
    return rows.map(describeTier);
  }

  /**
   * Create a commission tier. Like the risk-model versions, this only ever
   * *creates* — an existing tier is never edited, so a settled transaction's
   * commission can always be traced to the tier text that was in force. The
   * money bounds go through `Money` so a malformed amount is rejected here, not
   * discovered as a bad `numeric` cast at the database.
   */
  async createCommissionTier(
    input: {
      minTransactionAmount: string;
      maxTransactionAmount?: string;
      commissionPercentage: number;
      fixedCommissionAmount?: string;
      feePayer: string;
      effectiveFrom?: string;
    },
    ctx: ActorContext,
  ): Promise<Record<string, unknown>> {
    const min = Money.from(input.minTransactionAmount);
    const max = input.maxTransactionAmount ? Money.from(input.maxTransactionAmount) : null;
    const fixed = Money.from(input.fixedCommissionAmount ?? '0.000');
    if (min.isNegative() || fixed.isNegative()) {
      throw AppException.validation('Commission amounts cannot be negative.');
    }
    if (max && max.lessThan(min)) {
      throw AppException.validation('maxTransactionAmount cannot be below minTransactionAmount.');
    }
    if (input.commissionPercentage < 0) {
      throw AppException.validation('commissionPercentage cannot be negative.');
    }

    return this.db.transaction(async (client) => {
      const { rows } = await client.query<CommissionTierRow>(
        `INSERT INTO commission_tiers
           (min_transaction_amount, max_transaction_amount, commission_percentage,
            fixed_commission_amount, fee_payer, effective_from, created_by)
         VALUES ($1::numeric,$2::numeric,$3::numeric,$4::numeric,$5::fee_payer,
                 COALESCE($6::timestamptz, now()), $7::uuid)
         RETURNING id, min_transaction_amount::text, max_transaction_amount::text,
                   commission_percentage, fixed_commission_amount::text, fee_payer,
                   effective_from, is_active`,
        [
          min.toString(),
          max ? max.toString() : null,
          input.commissionPercentage,
          fixed.toString(),
          input.feePayer,
          input.effectiveFrom ?? null,
          ctx.userId,
        ],
      );
      await this.audit.recordIn(client, {
        actionType: 'COMMISSION_TIER_CREATED',
        targetEntityType: 'COMMISSION_TIER',
        targetEntityId: rows[0].id,
        previousValue: null,
        newValue: describeTier(rows[0]),
      });
      return describeTier(rows[0]);
    });
  }

  // ---------------------------------------------------------------
  // Audit log
  // ---------------------------------------------------------------

  /** The audit trail, newest first, optionally scoped to one entity. */
  async getAuditLogs(filters: {
    page: number;
    pageSize: number;
    targetEntityId?: string;
  }): Promise<Record<string, unknown>> {
    const params: unknown[] = [];
    let where = '';
    if (filters.targetEntityId) {
      params.push(filters.targetEntityId);
      where = `WHERE target_entity_id = $1`;
    }

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs ${where}`,
      params,
    );
    const total = Number(totalRow?.count ?? '0');

    params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const { rows } = await this.db.query<AuditLogRow>(
      `SELECT id, actor_user_id, actor_org_id, action_type, target_entity_type,
              target_entity_id, previous_value, new_value, occurred_at
         FROM audit_logs ${where}
        ORDER BY occurred_at DESC, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: rows.map(describeAuditLog),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize) || 1,
      },
    };
  }

  // ---------------------------------------------------------------
  // Relisting approval (ZM-REC-018)
  // ---------------------------------------------------------------

  /**
   * Approve a relisting request the withdrawal flow raised.
   *
   * A request is approvable only from `REQUESTED` or `UNDER_REVIEW`; approving
   * anything else is a 409, and a second approve of the same request returns it
   * unchanged rather than re-approving.
   *
   * **Note on the seven ZM-REC-018 checks (Q-18):** the requirement is that all
   * seven verification outcomes be recorded before approval, but neither the
   * frozen contract nor the overlay declares a surface to record them — the
   * approve endpoint has no request body, and the `verification` object is
   * written all-null by the withdrawal decision with no route to fill it. So
   * this cannot *enforce* the seven checks without inventing contract surface,
   * which is forbidden. It records the approval and the current verification
   * state in the audit entry so the gap is visible, and Q-18 raises it.
   */
  async approveRelisting(id: string, ctx: ActorContext): Promise<Record<string, unknown>> {
    return this.db.transaction(async (client: PoolClient) => {
      const { rows } = await client.query<RelistingRow>(
        `SELECT id, transaction_id, status, verification, notes, requested_at,
                decided_at, decision_notes
           FROM relisting_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (rows.length === 0) throw AppException.notFound('Relisting request');
      const request = rows[0];

      // Idempotent: an already-approved request comes back unchanged.
      if (request.status === 'APPROVED') return describeRelisting(request);

      if (request.status !== 'REQUESTED' && request.status !== 'UNDER_REVIEW') {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          `A ${request.status} relisting request cannot be approved.`,
          { status: request.status },
        );
      }

      const { rows: updated } = await client.query<RelistingRow>(
        `UPDATE relisting_requests
            SET status = 'APPROVED', decided_by = $2::uuid, decided_at = now()
          WHERE id = $1
        RETURNING id, transaction_id, status, verification, notes, requested_at,
                  decided_at, decision_notes`,
        [id, ctx.userId],
      );

      await this.audit.recordIn(client, {
        actionType: 'RELISTING_REQUEST_APPROVED',
        targetEntityType: 'RELISTING_REQUEST',
        targetEntityId: id,
        previousValue: { status: request.status, verification: request.verification },
        newValue: { status: 'APPROVED', verification: updated[0].verification },
      });

      this.logger.log(`Relisting request ${id} approved by ${ctx.userId}`);
      return describeRelisting(updated[0]);
    });
  }
}

interface CommissionTierRow {
  id: string;
  min_transaction_amount: string;
  max_transaction_amount: string | null;
  commission_percentage: string;
  fixed_commission_amount: string;
  fee_payer: string;
  effective_from: Date;
  is_active: boolean;
}

function describeTier(row: CommissionTierRow): Record<string, unknown> {
  return {
    id: row.id,
    minTransactionAmount: row.min_transaction_amount,
    maxTransactionAmount: row.max_transaction_amount,
    commissionPercentage: Number(row.commission_percentage),
    fixedCommissionAmount: row.fixed_commission_amount,
    feePayer: row.fee_payer,
    effectiveFrom: row.effective_from.toISOString(),
    isActive: row.is_active,
  };
}

interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  actor_org_id: string | null;
  action_type: string;
  target_entity_type: string;
  target_entity_id: string | null;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  occurred_at: Date;
}

function describeAuditLog(row: AuditLogRow): Record<string, unknown> {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorOrgId: row.actor_org_id,
    actionType: row.action_type,
    targetEntityType: row.target_entity_type,
    targetEntityId: row.target_entity_id,
    previousValue: row.previous_value,
    newValue: row.new_value,
    occurredAt: row.occurred_at.toISOString(),
  };
}

interface RelistingRow {
  id: string;
  transaction_id: string;
  status: string;
  verification: Record<string, boolean | null>;
  notes: string | null;
  requested_at: Date;
  decided_at: Date | null;
  decision_notes: string | null;
}

function describeRelisting(row: RelistingRow): Record<string, unknown> {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    status: row.status,
    verification: row.verification,
    notes: row.notes,
    requestedAt: row.requested_at.toISOString(),
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decisionNotes: row.decision_notes,
  };
}
