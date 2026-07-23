import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { AuditService } from '../../common/audit/audit.service';
import type { ActorContext } from '../onboarding/onboarding.service';

/**
 * Bank policy filters (ZM-MKT-002, D-12).
 *
 * A bank's underwriting appetite is commercially sensitive — knowing that a
 * competitor will not touch invoices under 50 000 JOD is worth money — so
 * every read and write here is scoped to the active bank organization, and
 * the RLS policy `policy_filters_read` enforces the same rule one layer down
 * for anyone reaching the database directly.
 *
 * D-12 added PATCH for edit and deactivate. Deactivation is a flag rather
 * than a delete: eligibility decisions cite the filter that made them, and
 * deleting the filter would orphan the `rules_applied` trace that ZM-MKT-003
 * exists to preserve.
 */

export interface PolicyFilterRow {
  id: string;
  bank_org_id: string;
  name: string;
  is_active: boolean;
  min_amount: string | null;
  max_amount: string | null;
  min_tenor_days: number | null;
  max_tenor_days: number | null;
  accepted_transaction_types: string[] | null;
  accepted_recourse_types: string[] | null;
  min_trust_score: number | null;
  max_risk_band: string | null;
  sectors_include: string[] | null;
  sectors_exclude: string[] | null;
  governorates_include: string[] | null;
  buyer_exclude_ids: string[] | null;
  supplier_exclude_ids: string[] | null;
  default_transaction_type: string | null;
  created_at: Date;
}

export interface PolicyFilterInput {
  name?: string;
  isActive?: boolean;
  minAmount?: string | null;
  maxAmount?: string | null;
  minTenorDays?: number | null;
  maxTenorDays?: number | null;
  acceptedTransactionTypes?: string[] | null;
  acceptedRecourseTypes?: string[] | null;
  minTrustScore?: number | null;
  maxRiskBand?: string | null;
  sectorsInclude?: string[] | null;
  sectorsExclude?: string[] | null;
  governoratesInclude?: string[] | null;
  defaultTransactionType?: string | null;
}

@Injectable()
export class PolicyFiltersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listForBank(ctx: ActorContext): Promise<PolicyFilterRow[]> {
    const { rows } = await this.db.query<PolicyFilterRow>(
      `SELECT * FROM bank_policy_filters WHERE bank_org_id = $1 ORDER BY created_at`,
      [ctx.organizationId],
    );
    return rows;
  }

  async create(ctx: ActorContext, input: PolicyFilterInput): Promise<PolicyFilterRow> {
    const { rows } = await this.db.query<PolicyFilterRow>(
      `INSERT INTO bank_policy_filters
         (bank_org_id, name, is_active, min_amount, max_amount, min_tenor_days,
          max_tenor_days, accepted_transaction_types, accepted_recourse_types,
          min_trust_score, max_risk_band, sectors_include, sectors_exclude,
          governorates_include, default_transaction_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::transaction_type[],$9::recourse_type[],
               $10,$11::risk_band,$12,$13,$14,$15::transaction_type)
       RETURNING *`,
      [
        ctx.organizationId,
        input.name ?? 'Unnamed filter',
        input.isActive !== false,
        input.minAmount ?? null,
        input.maxAmount ?? null,
        input.minTenorDays ?? null,
        input.maxTenorDays ?? null,
        input.acceptedTransactionTypes ?? null,
        input.acceptedRecourseTypes ?? null,
        input.minTrustScore ?? null,
        input.maxRiskBand ?? null,
        input.sectorsInclude ?? null,
        input.sectorsExclude ?? null,
        input.governoratesInclude ?? null,
        input.defaultTransactionType ?? null,
      ],
    );

    await this.audit.record({
      actionType: 'POLICY_FILTER_CREATED',
      targetEntityType: 'BANK_POLICY_FILTER',
      targetEntityId: rows[0].id,
      previousValue: null,
      newValue: { name: rows[0].name, isActive: rows[0].is_active },
    });
    return rows[0];
  }

  /**
   * Partial update (D-12).
   *
   * Only the fields present in the body are touched — a PATCH that omits
   * `minAmount` must not clear it. `undefined` means "not supplied" and
   * `null` means "clear this rule"; conflating the two is how a bank's
   * appetite silently widens after an unrelated edit.
   */
  async update(id: string, ctx: ActorContext, input: PolicyFilterInput): Promise<PolicyFilterRow> {
    const existing = await this.db.queryOne<PolicyFilterRow>(
      `SELECT * FROM bank_policy_filters WHERE id = $1 AND bank_org_id = $2`,
      [id, ctx.organizationId],
    );
    if (!existing) throw AppException.notFound('Policy filter');

    const assignments: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast = ''): void => {
      if (value === undefined) return;
      params.push(value);
      assignments.push(`${column} = $${params.length}${cast}`);
    };

    set('name', input.name);
    set('is_active', input.isActive);
    set('min_amount', input.minAmount);
    set('max_amount', input.maxAmount);
    set('min_tenor_days', input.minTenorDays);
    set('max_tenor_days', input.maxTenorDays);
    set('accepted_transaction_types', input.acceptedTransactionTypes, '::transaction_type[]');
    set('accepted_recourse_types', input.acceptedRecourseTypes, '::recourse_type[]');
    set('min_trust_score', input.minTrustScore);
    set('max_risk_band', input.maxRiskBand, '::risk_band');
    set('sectors_include', input.sectorsInclude);
    set('sectors_exclude', input.sectorsExclude);
    set('governorates_include', input.governoratesInclude);
    set('default_transaction_type', input.defaultTransactionType, '::transaction_type');

    if (assignments.length === 0) return existing;

    const { rows } = await this.db.query<PolicyFilterRow>(
      `UPDATE bank_policy_filters SET ${assignments.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );

    await this.audit.record({
      actionType: 'POLICY_FILTER_UPDATED',
      targetEntityType: 'BANK_POLICY_FILTER',
      targetEntityId: id,
      previousValue: { name: existing.name, isActive: existing.is_active },
      newValue: { name: rows[0].name, isActive: rows[0].is_active },
    });
    return rows[0];
  }

  describe(row: PolicyFilterRow): Record<string, unknown> {
    return {
      id: row.id,
      name: row.name,
      isActive: row.is_active,
      minAmount: row.min_amount,
      maxAmount: row.max_amount,
      minTenorDays: row.min_tenor_days,
      maxTenorDays: row.max_tenor_days,
      acceptedTransactionTypes: row.accepted_transaction_types ?? [],
      acceptedRecourseTypes: row.accepted_recourse_types ?? [],
      minTrustScore: row.min_trust_score,
      maxRiskBand: row.max_risk_band,
      sectorsInclude: row.sectors_include ?? [],
      sectorsExclude: row.sectors_exclude ?? [],
      defaultTransactionType: row.default_transaction_type,
    };
  }
}
