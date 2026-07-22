import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.service';
import { AppConfig } from '../../config/configuration';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { GovernmentService } from '../government/government.service';
import { isSourceAvailable } from '../government/government-adapter';
import { SlaClockService } from './sla-clock.service';
import {
  ApplicationStatus,
  RegistryFacts,
  assessHardRejection,
  organizationStatusFor,
  requireTransition,
} from './application-state';

/**
 * Supplier onboarding: bootstrap, application lifecycle, government
 * verification, and the reviewer decision.
 *
 * Every status change goes through `transition()`, which is the only place
 * that writes `supplier_applications.status`. That is what keeps the SLA
 * clock honest: a transition and its clock event are written in one
 * transaction, so there is no path that changes state without recording
 * what it did to the clock (ZM-SON-008).
 */

export interface ApplicationRow {
  id: string;
  organization_id: string;
  status: ApplicationStatus;
  submitted_at: Date | null;
  decided_at: Date | null;
  decision_reason_code: string | null;
  decision_notes: string | null;
}

export interface ActorContext {
  userId: string;
  organizationId: string;
  organizationType: string;
  roles: readonly string[];
}

const REVIEWER_ROLES = ['PLATFORM_SUPPLIER_REVIEWER', 'PLATFORM_SUPER_ADMIN', 'PLATFORM_OPS_ADMIN'];

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: AppConfig,
    private readonly government: GovernmentService,
    private readonly sla: SlaClockService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  private isReviewer(ctx: ActorContext): boolean {
    return ctx.roles.some((role) => REVIEWER_ROLES.includes(role));
  }

  // ------------------------------------------------------------------
  // Bootstrap (D-04)
  // ------------------------------------------------------------------

  /**
   * Create the organization, the owner membership, and a draft application
   * in one transaction.
   *
   * Idempotent per user, as the overlay requires: a second call while an
   * ONBOARDING organization already exists returns the same ids with 200.
   * The alternative — a duplicate organization per double-click — is
   * unrecoverable for the user, since they cannot see or delete either one.
   */
  async register(
    userId: string,
    input: { nationalEstablishmentNumber: string; professionLicenceNumber: string },
  ): Promise<{ organizationId: string; applicationId: string; created: boolean }> {
    const establishmentNo = input.nationalEstablishmentNumber.trim();

    return this.db.transaction(async (client) => {
      // Already bootstrapped? Return what exists.
      const existing = await client.query<{ organization_id: string; application_id: string }>(
        `SELECT o.id AS organization_id, a.id AS application_id
           FROM organization_memberships m
           JOIN organizations o ON o.id = m.organization_id
           LEFT JOIN supplier_applications a ON a.organization_id = o.id
          WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND o.organization_type = 'SUPPLIER'
          ORDER BY a.created_at ASC NULLS LAST
          LIMIT 1`,
        [userId],
      );
      if (existing.rows.length > 0 && existing.rows[0].application_id) {
        return {
          organizationId: existing.rows[0].organization_id,
          applicationId: existing.rows[0].application_id,
          created: false,
        };
      }

      // ZM-AUD-006: the establishment number is unique platform-wide for
      // suppliers. The partial unique index enforces it; checking first
      // turns a raw constraint violation into the contract's 409.
      const taken = await client.query(
        `SELECT 1 FROM organizations
          WHERE national_establishment_no = $1 AND organization_type = 'SUPPLIER' LIMIT 1`,
        [establishmentNo],
      );
      if (taken.rows.length > 0) {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'This national establishment number is already registered to another organization.',
          { nationalEstablishmentNumber: establishmentNo },
        );
      }

      // The legal name is intentionally a placeholder until CCD answers.
      // Letting the applicant type their own legal name and treating it as
      // fact would make the government lookup decorative — ZM-SON-004 says
      // self-declared never overwrites government, and the cleanest way to
      // honour that is to not collect a competing value at all.
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations
           (organization_type, legal_name, status, national_establishment_no)
         VALUES ('SUPPLIER', $1, 'ONBOARDING', $2)
         RETURNING id`,
        [`Establishment ${establishmentNo}`, establishmentNo],
      );
      const organizationId = org.rows[0].id;

      const membership = await client.query<{ id: string }>(
        `INSERT INTO organization_memberships (user_id, organization_id, status, is_authorized_signatory)
         VALUES ($1, $2, 'ACTIVE', true)
         RETURNING id`,
        [userId, organizationId],
      );
      await client.query(
        `INSERT INTO membership_roles (membership_id, role) VALUES ($1, 'SUPPLIER_OWNER')`,
        [membership.rows[0].id],
      );

      const application = await client.query<{ id: string }>(
        `INSERT INTO supplier_applications (organization_id, status) VALUES ($1, 'DRAFT') RETURNING id`,
        [organizationId],
      );
      const applicationId = application.rows[0].id;

      // The licence number is the applicant's own claim until GAM confirms
      // it, so it is recorded as SELF_DECLARED with that provenance.
      await this.government.recordSelfDeclared(
        'ORGANIZATION',
        organizationId,
        { professionLicenceNumber: input.professionLicenceNumber.trim() },
        client,
      );

      return { organizationId, applicationId, created: true };
    });
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async getApplicationRow(id: string): Promise<ApplicationRow | null> {
    return this.db.queryOne<ApplicationRow>(
      `SELECT id, organization_id, status, submitted_at, decided_at,
              decision_reason_code, decision_notes
         FROM supplier_applications WHERE id = $1`,
      [id],
    );
  }

  /**
   * Fetch an application the caller is entitled to see.
   *
   * A supplier may see its own; a platform reviewer may see any. Anything
   * else is a 404 rather than a 403 — telling a stranger that an
   * application exists but is not theirs is an enumeration oracle, and the
   * same reasoning already governs the org-context 403 pair.
   */
  async requireVisibleApplication(id: string, ctx: ActorContext): Promise<ApplicationRow> {
    const row = await this.getApplicationRow(id);
    if (!row) throw AppException.notFound('Application');
    if (this.isReviewer(ctx)) return row;
    if (row.organization_id !== ctx.organizationId) throw AppException.notFound('Application');
    return row;
  }

  /** Application plus SLA state and government-derived fields. */
  async describe(row: ApplicationRow): Promise<Record<string, unknown>> {
    const [slaState, fields] = await Promise.all([
      this.sla.stateOf(row.id),
      this.government.effectiveFields('ORGANIZATION', row.organization_id),
    ]);

    // Government-derived fields are exposed with their provenance so Agent
    // B can render the source badge and retrieval date, and render them
    // read-only. A bare value with no source would make that impossible.
    const governmentData: Record<string, unknown> = {};
    for (const [key, meta] of Object.entries(fields)) {
      governmentData[key] = {
        value: meta.value,
        sourceKind: meta.sourceKind,
        source: meta.source,
        retrievedAt: meta.retrievedAt?.toISOString() ?? null,
      };
    }

    return {
      id: row.id,
      organizationId: row.organization_id,
      status: row.status,
      slaDeadlineAt: slaState.deadlineAt?.toISOString() ?? null,
      slaRemainingBusinessSeconds: slaState.remainingBusinessSeconds,
      slaPaused: slaState.paused,
      slaPausedReason: slaState.pausedReason,
      submittedAt: row.submitted_at?.toISOString() ?? null,
      decidedAt: row.decided_at?.toISOString() ?? null,
      decisionReasonCode: row.decision_reason_code,
      governmentData,
    };
  }

  /** D-05 — supplier sees its own; reviewer sees the queue. */
  async list(
    ctx: ActorContext,
    filters: { status?: string; page: number; pageSize: number },
  ): Promise<{ items: Record<string, unknown>[]; pagination: Record<string, number> }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (!this.isReviewer(ctx)) {
      params.push(ctx.organizationId);
      conditions.push(`organization_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalRow = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM supplier_applications ${where}`,
      params,
    );
    const total = Number(totalRow?.count ?? '0');

    params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const { rows } = await this.db.query<ApplicationRow>(
      `SELECT id, organization_id, status, submitted_at, decided_at,
              decision_reason_code, decision_notes
         FROM supplier_applications ${where}
        ORDER BY submitted_at DESC NULLS LAST, id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: await Promise.all(rows.map((row) => this.describe(row))),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize) || 1,
      },
    };
  }

  // ------------------------------------------------------------------
  // The single writer of status
  // ------------------------------------------------------------------

  /**
   * Apply a state transition and its clock consequence atomically.
   *
   * The clock event is written inside the same transaction as the status
   * update, so a rollback takes both. This is the property the SLA depends
   * on — an INFORMATION_REQUIRED that committed while its PAUSE did not
   * would bill the platform for time it was waiting on the supplier, and
   * nothing downstream could detect it.
   */
  private async transition(
    client: PoolClient,
    application: ApplicationRow,
    to: ApplicationStatus,
    actorUserId: string | null,
    extra: { reasonCode?: string; notes?: string; reasonOverride?: string } = {},
  ): Promise<ApplicationStatus> {
    const rule = requireTransition(application.status, to);
    const reason = extra.reasonOverride ?? rule.reason;

    // Every placeholder is cast explicitly. Postgres infers an unanchored
    // parameter inside a CASE as `text`, which made COALESCE(submitted_at,
    // <text>) fail at runtime while typechecking and unit tests passed —
    // the kind of defect only executing the query finds.
    await client.query(
      `UPDATE supplier_applications
          SET status = $2::supplier_application_status,
              submitted_at = COALESCE(
                submitted_at,
                CASE WHEN $2::text = 'SUBMITTED' THEN $5::timestamptz END
              ),
              decided_at = CASE
                WHEN $2::text IN ('APPROVED','APPROVED_CONDITIONAL','REJECTED') THEN $5::timestamptz
                ELSE decided_at
              END,
              decided_by = CASE
                WHEN $2::text IN ('APPROVED','APPROVED_CONDITIONAL','REJECTED') THEN $6::uuid
                ELSE decided_by
              END,
              decision_reason_code = COALESCE($3::text, decision_reason_code),
              decision_notes = COALESCE($4::text, decision_notes),
              updated_at = now()
        WHERE id = $1::uuid`,
      [
        application.id,
        to,
        extra.reasonCode ?? null,
        extra.notes ?? null,
        this.time.now(),
        actorUserId,
      ],
    );

    if (rule.clock) {
      await this.sla.record(client, application.id, rule.clock, reason, actorUserId);
    }
    await this.sla.syncApplicationColumns(client, application.id);

    // A decision propagates to the organization: ZM-SON-011's conditional
    // state is an organization status, not a flag on the application.
    const orgStatus = organizationStatusFor(to);
    if (orgStatus) {
      await client.query(`UPDATE organizations SET status = $2, updated_at = now() WHERE id = $1`, [
        application.organization_id,
        orgStatus,
      ]);
    }

    application.status = to;
    return to;
  }

  // ------------------------------------------------------------------
  // Supplier actions
  // ------------------------------------------------------------------

  async submit(id: string, ctx: ActorContext): Promise<Record<string, unknown>> {
    const application = await this.requireVisibleApplication(id, ctx);

    await this.db.transaction(async (client) => {
      await this.transition(client, application, 'SUBMITTED', ctx.userId);
      await this.transition(client, application, 'AUTOMATED_VERIFICATION', ctx.userId);
    });

    // Registry calls happen outside the transaction: they are slow, they
    // can time out, and holding a database transaction open across a
    // network call to a third party is how connection pools die.
    await this.runAutomatedVerification(id, ctx.userId);

    const refreshed = await this.getApplicationRow(id);
    if (!refreshed) throw AppException.notFound('Application');
    return this.describe(refreshed);
  }

  /**
   * Run the registry checks and route the application accordingly.
   *
   * The order of the branches is the requirement, not a preference:
   * availability is checked BEFORE eligibility. ZM-SON-010 forbids downtime
   * from causing a rejection, and asking "is this applicant eligible?" using
   * facts a source never supplied is exactly how that would happen.
   */
  async runAutomatedVerification(applicationId: string, actorUserId: string | null): Promise<void> {
    const application = await this.getApplicationRow(applicationId);
    if (!application) throw AppException.notFound('Application');

    const org = await this.db.queryOne<{ national_establishment_no: string | null }>(
      `SELECT national_establishment_no FROM organizations WHERE id = $1`,
      [application.organization_id],
    );
    const lookupKey = org?.national_establishment_no;
    if (!lookupKey) {
      throw AppException.validation('The organization has no national establishment number.');
    }

    const outcome = await this.government.lookupAll(
      lookupKey,
      'ORGANIZATION',
      application.organization_id,
    );

    if (outcome.anySourceUnavailable) {
      // Paused, not adverse. The supplier sees "waiting on a government
      // service", the clock stops, and nothing about their business has
      // been judged.
      const unavailable = outcome.results.filter((r) => !isSourceAvailable(r.result));
      this.logger.warn(
        `Application ${applicationId}: ${unavailable
          .map((r) => r.source)
          .join(', ')} unavailable — pausing the SLA clock, not rejecting.`,
      );
      await this.db.transaction(async (client) => {
        await this.transition(client, application, 'GOVERNMENT_SERVICE_UNAVAILABLE', actorUserId);
      });
      return;
    }

    const facts = await this.registryFactsFor(application.organization_id, outcome);
    const rejection = assessHardRejection(facts);

    await this.db.transaction(async (client) => {
      if (rejection) {
        await this.transition(client, application, 'REJECTED', actorUserId, {
          reasonCode: rejection.reasonCode,
          notes: rejection.message,
          reasonOverride: rejection.reasonCode,
        });
        return;
      }
      await this.transition(client, application, 'UNDER_REVIEW', actorUserId);
      // The legal name now comes from CCD rather than the placeholder.
      await this.adoptGovernmentLegalName(client, application.organization_id);
    });
  }

  /** Facts the hard-rejection rules are assessed on — answered sources only. */
  private async registryFactsFor(
    organizationId: string,
    outcome: Awaited<ReturnType<GovernmentService['lookupAll']>>,
  ): Promise<RegistryFacts> {
    const fields = await this.government.effectiveFields('ORGANIZATION', organizationId);
    const ccd = outcome.results.find((r) => r.source === 'CCD');
    return {
      companyType: fields.companyType?.value ?? undefined,
      registryStatus: fields.registryStatus?.value ?? undefined,
      licenceStatus: fields.licenceStatus?.value ?? undefined,
      notFoundInCcd: ccd?.result.status === 'NOT_FOUND',
    };
  }

  private async adoptGovernmentLegalName(client: PoolClient, organizationId: string): Promise<void> {
    await client.query(
      `UPDATE organizations o
          SET legal_name = v.field_value, updated_at = now()
         FROM entity_field_values v
        WHERE o.id = $1
          AND v.entity_type = 'ORGANIZATION' AND v.entity_id = $1
          AND v.field_key = 'legalNameEn' AND v.source_kind = 'GOVERNMENT'
          AND v.superseded_at IS NULL
          AND v.field_value IS NOT NULL`,
      [organizationId],
    );
  }

  /**
   * Retry the registry after an outage.
   *
   * Activity-triggered, never a background sweep — ZM-GOV-006 forbids
   * scheduled re-verification in V3.
   */
  async retryGovernment(id: string, ctx: ActorContext): Promise<Record<string, unknown>> {
    const application = await this.requireVisibleApplication(id, ctx);
    if (application.status !== 'GOVERNMENT_SERVICE_UNAVAILABLE') {
      throw new AppException(
        ErrorCode.INVALID_STATE_TRANSITION,
        'This application is not waiting on a government service.',
        HttpStatus.CONFLICT,
        { status: application.status },
      );
    }

    await this.db.transaction(async (client) => {
      await this.transition(client, application, 'AUTOMATED_VERIFICATION', ctx.userId);
    });
    await this.runAutomatedVerification(id, ctx.userId);

    const refreshed = await this.getApplicationRow(id);
    if (!refreshed) throw AppException.notFound('Application');
    return this.describe(refreshed);
  }

  async addBankAccount(
    id: string,
    ctx: ActorContext,
    input: { iban: string; bankName: string; accountHolderName: string; evidenceDocumentId?: string },
  ): Promise<void> {
    const application = await this.requireVisibleApplication(id, ctx);
    const iban = input.iban.replace(/\s+/g, '').toUpperCase();
    if (!/^JO\d{2}[A-Z0-9]{4}\d{22}$/.test(iban)) {
      throw AppException.validation('The IBAN is not a valid Jordanian IBAN.', { field: 'iban' });
    }

    await this.db.query(
      `INSERT INTO supplier_bank_accounts
         (organization_id, iban_enc, iban_last4, bank_name, account_holder_name, verification_status, is_primary)
       VALUES ($1, pgp_sym_encrypt($2, $3), $4, $5, $6, 'PENDING', true)`,
      [
        application.organization_id,
        iban,
        this.config.encryptionKey,
        iban.slice(-4),
        input.bankName,
        input.accountHolderName,
      ],
    );
  }

  async recordConsents(
    id: string,
    ctx: ActorContext,
    consents: { consentType: string; consentVersion: string; granted: boolean }[],
  ): Promise<void> {
    const application = await this.requireVisibleApplication(id, ctx);
    await this.db.transaction(async (client) => {
      for (const consent of consents) {
        // The hash pins which text was agreed to. Storing only a version
        // string makes "which words did they accept?" unanswerable once the
        // document is edited.
        const hash = createHash('sha256')
          .update(`${consent.consentType}:${consent.consentVersion}`)
          .digest('hex');
        await client.query(
          `INSERT INTO consent_records
             (organization_id, user_id, consent_type, consent_version, consent_text_hash, granted, granted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            application.organization_id,
            ctx.userId,
            consent.consentType,
            consent.consentVersion,
            hash,
            consent.granted,
            this.time.now(),
          ],
        );
      }
    });
  }

  async listInformationRequests(id: string, ctx: ActorContext): Promise<Record<string, unknown>[]> {
    await this.requireVisibleApplication(id, ctx);
    const { rows } = await this.db.query<{
      id: string;
      requested_item: string;
      description: string | null;
      status: string;
      requested_at: Date;
    }>(
      `SELECT id, requested_item, description, status, requested_at
         FROM information_requests
        WHERE subject_type = 'SUPPLIER_APPLICATION' AND subject_id = $1
        ORDER BY requested_at DESC`,
      [id],
    );
    return rows.map((r) => ({
      id: r.id,
      requestedItem: r.requested_item,
      description: r.description,
      status: r.status,
      requestedAt: r.requested_at.toISOString(),
    }));
  }

  /** The supplier answers — this is what resumes the clock. */
  async respond(
    id: string,
    ctx: ActorContext,
    input: { informationRequestId: string; response: string },
  ): Promise<void> {
    const application = await this.requireVisibleApplication(id, ctx);

    await this.db.transaction(async (client) => {
      const request = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM information_requests
          WHERE id = $1 AND subject_type = 'SUPPLIER_APPLICATION' AND subject_id = $2
          FOR UPDATE`,
        [input.informationRequestId, id],
      );
      if (request.rows.length === 0) throw AppException.notFound('Information request');
      if (request.rows[0].status !== 'OPEN') {
        throw AppException.conflict(
          ErrorCode.CONFLICT,
          'This information request has already been closed.',
        );
      }

      await client.query(
        `UPDATE information_requests SET status = 'FULFILLED', fulfilled_at = $2 WHERE id = $1`,
        [input.informationRequestId, this.time.now()],
      );
      await this.government.recordSelfDeclared(
        'ORGANIZATION',
        application.organization_id,
        { [`informationResponse:${input.informationRequestId}`]: input.response },
        client,
      );

      // Only resume when nothing else is outstanding. Resuming while a
      // second request is still open would restart the platform's clock
      // during time it is still waiting on the supplier.
      const stillOpen = await client.query(
        `SELECT 1 FROM information_requests
          WHERE subject_type = 'SUPPLIER_APPLICATION' AND subject_id = $1 AND status = 'OPEN'
          LIMIT 1`,
        [id],
      );
      if (stillOpen.rows.length === 0 && application.status === 'INFORMATION_REQUIRED') {
        await this.transition(client, application, 'INFORMATION_RESUBMITTED', ctx.userId);
      }
    });
  }

  // ------------------------------------------------------------------
  // Reviewer action
  // ------------------------------------------------------------------

  async decide(
    id: string,
    ctx: ActorContext,
    input: { decision: string; reasonCode?: string; notes?: string; requestedItem?: string },
  ): Promise<Record<string, unknown>> {
    if (!this.isReviewer(ctx)) throw AppException.insufficientRole(REVIEWER_ROLES);

    const application = await this.requireVisibleApplication(id, ctx);

    // A rejection without a reason code is unappealable and unauditable.
    if (input.decision === 'REJECTED' && !input.reasonCode) {
      throw AppException.validation('A rejection requires a structured reasonCode.', {
        field: 'reasonCode',
      });
    }

    await this.db.transaction(async (client) => {
      if (input.decision === 'INFORMATION_REQUIRED') {
        await client.query(
          `INSERT INTO information_requests
             (subject_type, subject_id, requested_item, description, status, requested_by, requested_at)
           VALUES ('SUPPLIER_APPLICATION', $1, $2, $3, 'OPEN', $4, $5)`,
          [
            id,
            input.requestedItem ?? input.reasonCode ?? 'ADDITIONAL_INFORMATION',
            input.notes ?? null,
            ctx.userId,
            this.time.now(),
          ],
        );
      }

      await this.transition(client, application, input.decision as ApplicationStatus, ctx.userId, {
        reasonCode: input.reasonCode,
        notes: input.notes,
      });
    });

    const refreshed = await this.getApplicationRow(id);
    if (!refreshed) throw AppException.notFound('Application');
    return this.describe(refreshed);
  }
}
