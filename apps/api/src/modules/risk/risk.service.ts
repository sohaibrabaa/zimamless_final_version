import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import { AuditService } from '../../common/audit/audit.service';
import { TransactionsService } from '../transactions/transactions.service';
import { DocumentsService } from '../documents/documents.service';
import { RiskModelClientService } from './risk-model-client.service';
import { RiskModelsService, type ResolvedModel } from './risk-models.service';
import { capForBlockers, hardBlockers } from './rules-engine';
import { INFO_CODES } from './reason-codes';
import {
  allComponents,
  bandOf,
  blendWithModel,
  collectCodes,
  compositeOf,
  dataAvailabilityPct,
  type ComponentResult,
  type RiskBand,
} from './scoring';
import { known, unavailable, type Maybe, type RiskFacts } from './facts';

/**
 * Trust Score orchestration.
 *
 * The order of operations is the requirement, not an implementation detail:
 *
 *   1. gather facts, preserving availability as a *shape* (see `facts.ts`)
 *   2. score five components — unavailable signals drop out of the average
 *   3. compute `dataAvailabilityPct` on its own track from the same signals
 *   4. blend the model's estimate into the composite, if the model answered
 *   5. apply the deterministic blocker cap LAST (ZM-RSK-015)
 *
 * Step 5 after step 4 is what makes "the model cannot override a blocker"
 * true by construction rather than by review.
 */

/** ZM-RSK-002. Returned with every score, in the caller's language. */
const DISCLAIMER = {
  EN:
    'This Trust Score is decision support only. It is not a guarantee, not a credit ' +
    'rating, and not a substitute for the bank’s own credit assessment. It is ' +
    'calculated from platform and registry data using a model trained on synthetic ' +
    'demonstration data.',
  AR:
    'درجة الثقة هذه لأغراض دعم القرار فقط. وهي ليست ضماناً ولا تصنيفاً ائتمانياً ولا ' +
    'بديلاً عن التقييم الائتماني الخاص بالبنك. تُحتسب من بيانات المنصة والسجلات ' +
    'الرسمية باستخدام نموذج مُدرَّب على بيانات توضيحية اصطناعية.',
} as const;

export type RiskAudience = 'SUPPLIER' | 'BANK' | 'PLATFORM';

interface AssessmentRow {
  id: string;
  transaction_id: string;
  organization_id: string | null;
  model_version_id: string;
  composite_score: number;
  band: RiskBand;
  supplier_verification_score: number | null;
  data_confidence_score: number | null;
  buyer_profile_score: number | null;
  invoice_score: number | null;
  platform_behavior_score: number | null;
  data_availability_pct: string | null;
  positive_factors: string[];
  risk_factors: string[];
  reason_codes: string[];
  ml_used: boolean;
  ml_fallback_reason: string | null;
  calculated_at: Date;
}

@Injectable()
export class RiskService {
  constructor(
    private readonly db: DatabaseService,
    private readonly transactions: TransactionsService,
    private readonly documents: DocumentsService,
    private readonly models: RiskModelsService,
    private readonly modelClient: RiskModelClientService,
    private readonly audit: AuditService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  // =====================================================================
  // Fact gathering
  // =====================================================================

  /**
   * Reads everything scoring needs, mapping each fact to `Known` or
   * `Unavailable`.
   *
   * The mapping decisions are the interesting part. A government field the
   * platform never obtained becomes `Unavailable`, not a false or a zero — and
   * `entity_field_values` is the source of truth for that, because it records
   * per-field provenance from the Phase 2 verification run.
   */
  async gatherFacts(transactionId: string): Promise<RiskFacts> {
    const row = await this.transactions.findById(transactionId);
    if (!row) throw new Error(`Transaction ${transactionId} not found`);

    const invoice = await this.transactions.invoiceOf(transactionId);

    const supplierOrg = await this.db.queryOne<{ status: string }>(
      `SELECT status FROM organizations WHERE id = $1`,
      [row.supplier_org_id],
    );

    // ---- supplier, from government provenance --------------------------
    const { rows: fieldValues } = await this.db.query<{
      field_key: string;
      field_value: string | null;
      source_kind: string;
      retrieved_at: Date | null;
    }>(
      `SELECT field_key, field_value, source_kind, retrieved_at
         FROM entity_field_values
        WHERE entity_type = 'ORGANIZATION' AND entity_id = $1`,
      [row.supplier_org_id],
    );

    const now = this.time.now();
    const byKey = new Map(fieldValues.map((f) => [f.field_key, f]));
    const provenance = fieldValues.map((f) => ({
      sourceKind: (f.source_kind === 'GOVERNMENT' || f.source_kind === 'DERIVED'
        ? f.source_kind
        : 'SELF_DECLARED') as 'GOVERNMENT' | 'SELF_DECLARED' | 'DERIVED',
      ageDays: f.retrieved_at
        ? Math.max(0, Math.floor((now.getTime() - f.retrieved_at.getTime()) / 86_400_000))
        : 365,
    }));

    /** A field the platform holds, or an honest absence. */
    const field = (key: string): Maybe<string> => {
      const found = byKey.get(key);
      if (!found || found.field_value === null || found.field_value === '') {
        return unavailable('SOURCE_UNAVAILABLE');
      }
      return known(found.field_value);
    };

    const boolField = (key: string): Maybe<boolean> => {
      const value = field(key);
      return value.available ? known(value.value === 'true' || value.value === 'ACTIVE') : value;
    };

    // ---- buyer ----------------------------------------------------------
    const buyer = row.buyer_id
      ? await this.db.queryOne<{
          registry_status: string | null;
          registration_date: string | null;
        }>(
          `SELECT registry_status, registration_date::text AS registration_date
             FROM buyers WHERE id = $1`,
          [row.buyer_id],
        )
      : null;

    const relationship = row.buyer_id
      ? await this.db.queryOne<{ previous_transactions_count: number | null }>(
          `SELECT previous_transactions_count
             FROM supplier_buyer_relationships
            WHERE supplier_org_id = $1 AND buyer_id = $2`,
          [row.supplier_org_id, row.buyer_id],
        )
      : null;

    const paymentHistory = row.buyer_id
      ? await this.db.queryOne<{ total: string; on_time: string }>(
          `SELECT count(*)::text AS total,
                  count(*) FILTER (WHERE p.payment_date <= i.due_date)::text AS on_time
             FROM buyer_payments p
             JOIN receivable_transactions t ON t.id = p.transaction_id
             JOIN invoices i ON i.transaction_id = t.id
            WHERE t.buyer_id = $1`,
          [row.buyer_id],
        )
      : null;

    // ---- platform behaviour (always known — our own tables) -------------
    const behaviour = await this.db.queryOne<{
      prior: string;
      disputes: string;
      duplicates: string;
      recourse: string;
    }>(
      `SELECT
         (SELECT count(*) FROM receivable_transactions
           WHERE supplier_org_id = $1 AND state <> 'DRAFT' AND id <> $2)::text AS prior,
         (SELECT count(*) FROM disputes d
            JOIN receivable_transactions t ON t.id = d.transaction_id
           WHERE t.supplier_org_id = $1)::text AS disputes,
         (SELECT count(*) FROM fraud_cases f
           WHERE f.organization_id = $1)::text AS duplicates,
         (SELECT count(*) FROM recourse_cases r
            JOIN receivable_transactions t ON t.id = r.transaction_id
           WHERE t.supplier_org_id = $1)::text AS recourse`,
      [row.supplier_org_id, transactionId],
    );

    // ---- invoice and its document ---------------------------------------
    const documents = await this.documents.listForSubject('TRANSACTION', transactionId);
    const einvoice = documents.find((d) => d.document_type === 'ELECTRONIC_INVOICE') ?? null;

    let fileIntegrityOk: Maybe<boolean> = unavailable('SOURCE_UNAVAILABLE');
    let ocrConsistent: Maybe<boolean> = unavailable('SOURCE_UNAVAILABLE');
    let qrStatus: Maybe<'VALID' | 'INVALID' | 'UNPARSED' | 'UNAVAILABLE'> =
      unavailable('SOURCE_UNAVAILABLE');

    if (einvoice) {
      const integrity = await this.documents.verifyStoredHash(einvoice);
      if (integrity) fileIntegrityOk = known(integrity.matches);

      const extractions = await this.documents.latestExtractions(einvoice.id);
      const ocrRow = extractions.find((e) => e.extraction_kind === 'OCR');
      const qrRow = extractions.find((e) => e.extraction_kind === 'QR');

      if (ocrRow?.succeeded && invoice) {
        const fields = (ocrRow.extracted_fields ?? {}) as Record<string, string>;
        // Only compare what OCR actually read. A field it could not read is
        // not a mismatch — that is the same distinction as everywhere else.
        const comparable: [string | undefined, string][] = [
          [fields.invoiceNumber, invoice.invoice_number],
          [fields.faceValue, invoice.face_value],
        ];
        const present = comparable.filter(([read]) => read !== undefined && read !== '');
        ocrConsistent =
          present.length === 0
            ? unavailable('SOURCE_UNAVAILABLE')
            : known(present.every(([read, entered]) => read === entered));
      }

      if (qrRow) {
        const status = qrRow.succeeded
          ? 'VALID'
          : ((qrRow.failure_reason ?? 'UNAVAILABLE') as 'INVALID' | 'UNPARSED' | 'UNAVAILABLE');
        qrStatus = known(status);
      }
    }

    const tenorDays: Maybe<number> = invoice
      ? known(
          // Date.parse, not `new Date` — the repo bans the constructor in
          // domain code because it is how the wall clock sneaks past the
          // TimeProvider. `now` below comes from the provider, so the demo
          // time machine moves the tenor with it. Both sides are pinned to
          // UTC midnight so the result counts whole calendar days rather than
          // drifting with Asia/Amman's offset.
          Math.floor(
            (Date.parse(`${invoice.due_date}T00:00:00Z`) -
              Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
              86_400_000,
          ),
        )
      : unavailable('SOURCE_UNAVAILABLE');

    const completeness: Maybe<number> = invoice
      ? known(
          [
            invoice.invoice_number,
            invoice.einvoice_identifier,
            invoice.issue_date,
            invoice.due_date,
            invoice.payment_terms,
            invoice.purchase_order_number,
            invoice.goods_description,
          ].filter((v) => v !== null && v !== '').length / 7,
        )
      : unavailable('SOURCE_UNAVAILABLE');

    const duplicate = invoice
      ? await this.db.queryOne(
          `SELECT 1 FROM invoices
            WHERE fingerprint = $1 AND is_active_fingerprint AND transaction_id <> $2`,
          [invoice.fingerprint, transactionId],
        )
      : null;

    const registrationDate = buyer?.registration_date ?? null;

    return {
      transactionId,
      supplier: {
        organizationId: row.supplier_org_id,
        status: supplierOrg?.status ?? 'UNKNOWN',
        registryStatus: field('registryStatus'),
        bankAccountVerified: boolField('bankAccountVerified'),
        signatoryMatches: boolField('signatoryMatches'),
        taxStatusValid: boolField('taxStatusValid'),
        provenance,
        unobtainedFieldCount: 0,
        expectedFieldCount: fieldValues.length,
      },
      buyer: {
        registryStatus: buyer?.registry_status
          ? known(buyer.registry_status)
          : unavailable('SOURCE_UNAVAILABLE'),
        companyAgeYears: registrationDate
          ? known(
              Math.max(
                0,
                (now.getTime() - Date.parse(`${registrationDate}T00:00:00Z`)) /
                  (365.25 * 86_400_000),
              ),
            )
          : unavailable('NOT_PUBLISHED'),
        priorTransactionsWithSupplier:
          relationship?.previous_transactions_count !== null &&
          relationship?.previous_transactions_count !== undefined
            ? known(relationship.previous_transactions_count)
            : unavailable('SOURCE_UNAVAILABLE'),
        onTimePaymentRatio:
          paymentHistory && Number(paymentHistory.total) > 0
            ? known(Number(paymentHistory.on_time) / Number(paymentHistory.total))
            : unavailable('SOURCE_UNAVAILABLE'),
      },
      invoice: {
        present: invoice !== null,
        tenorDays,
        minTenorDays: 7,
        pastDue: tenorDays.available && tenorDays.value < 0,
        completenessRatio: completeness,
        electronicInvoiceAttached: einvoice !== null,
        fileIntegrityOk,
        ocrConsistent,
        qrStatus,
        duplicateCollision: duplicate !== null,
        partiallyPaid: invoice ? Number(invoice.paid_amount) > 0 : false,
        declarationsRecorded:
          (await this.db.queryOne(
            `SELECT 1 FROM invoice_declarations WHERE transaction_id = $1`,
            [transactionId],
          )) !== null,
      },
      platform: {
        priorSubmittedCount: Number(behaviour?.prior ?? 0),
        disputeCount: Number(behaviour?.disputes ?? 0),
        duplicateReferralCount: Number(behaviour?.duplicates ?? 0),
        recourseCount: Number(behaviour?.recourse ?? 0),
      },
    };
  }

  // =====================================================================
  // Calculation
  // =====================================================================

  /**
   * Takes no actor: the audit entry's actor comes from `RequestContextStore`,
   * which the interceptor populates per request. Threading an `ActorContext`
   * through as well would give two sources for the same fact and no rule for
   * which wins — visibility is checked by the caller, before this is reached.
   */
  async calculate(transactionId: string): Promise<AssessmentRow> {
    const model = await this.models.requireActive();
    const facts = await this.gatherFacts(transactionId);

    const components = allComponents(facts);
    const availability = dataAvailabilityPct(components);
    const blockers = hardBlockers(facts);
    const { positiveFactors, riskFactors, infoFactors } = collectCodes(components);

    // Step 4: the model's contribution. Requested only with facts that are
    // always known, so an unreachable registry cannot change what is sent.
    const ml = await this.modelClient.score({
      tenorDays: facts.invoice.tenorDays.available ? facts.invoice.tenorDays.value : 0,
      faceValue: await this.faceValueOf(transactionId),
      subtotalAmount: await this.subtotalOf(transactionId),
      taxAmount: await this.taxOf(transactionId),
      completenessRatio: facts.invoice.completenessRatio.available
        ? facts.invoice.completenessRatio.value
        : 1,
      duplicateCollision: facts.invoice.duplicateCollision,
      electronicInvoiceAttached: facts.invoice.electronicInvoiceAttached,
      partiallyPaid: facts.invoice.partiallyPaid,
      priorSubmittedCount: facts.platform.priorSubmittedCount,
      disputeCount: facts.platform.disputeCount,
      duplicateReferralCount: facts.platform.duplicateReferralCount,
      recourseCount: facts.platform.recourseCount,
    });

    const rulesComposite = compositeOf(components, model.weights);
    const blended =
      ml.modelAvailable && ml.riskProbability !== null
        ? blendWithModel(rulesComposite, ml.riskProbability, model.mlWeight)
        : rulesComposite;

    // Step 5, LAST: a hard blocker wins regardless of what the model said.
    const composite = capForBlockers(blended, blockers);

    const reasonCodes = [
      ...blockers.map((b) => b.code),
      ...riskFactors,
      ...infoFactors,
      ...(ml.modelAvailable ? [] : [INFO_CODES.ML_UNAVAILABLE]),
      ...(ml.synthetic ? [INFO_CODES.SYNTHETIC_TRAINING_DATA] : []),
    ];

    const stored = await this.persist({
      transactionId,
      supplierOrgId: facts.supplier.organizationId,
      model,
      components,
      composite,
      band: bandOf(composite, model.bandThresholds),
      availability,
      positiveFactors,
      riskFactors,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      mlUsed: ml.modelAvailable,
      mlFallbackReason: ml.unavailableReason,
    });

    await this.audit.record({
      actionType: 'RISK_ASSESSMENT_CALCULATED',
      targetEntityType: 'RISK_ASSESSMENT',
      targetEntityId: stored.id,
      previousValue: null,
      newValue: {
        transactionId,
        compositeScore: stored.composite_score,
        band: stored.band,
        modelVersionId: model.id,
        mlUsed: stored.ml_used,
      },
    });

    return stored;
  }

  private async persist(input: {
    transactionId: string;
    supplierOrgId: string;
    model: ResolvedModel;
    components: ComponentResult[];
    composite: number;
    band: RiskBand;
    availability: number;
    positiveFactors: string[];
    riskFactors: string[];
    reasonCodes: string[];
    mlUsed: boolean;
    mlFallbackReason: string | null;
  }): Promise<AssessmentRow> {
    const score = (key: string): number | null =>
      input.components.find((c) => c.key === key)?.score ?? null;

    const { rows } = await this.db.query<AssessmentRow>(
      `INSERT INTO risk_assessments
         (transaction_id, organization_id, model_version_id, composite_score, band,
          supplier_verification_score, data_confidence_score, buyer_profile_score,
          invoice_score, platform_behavior_score, data_availability_pct,
          positive_factors, risk_factors, reason_codes, ml_used, ml_fallback_reason,
          calculated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::text[],$15,$16,$17)
       RETURNING *`,
      [
        input.transactionId,
        input.supplierOrgId,
        input.model.id,
        input.composite,
        input.band,
        score('supplierVerification'),
        score('dataConfidence'),
        score('buyerProfile'),
        score('invoiceScore'),
        score('platformBehavior'),
        input.availability,
        JSON.stringify(input.positiveFactors),
        JSON.stringify(input.riskFactors),
        input.reasonCodes,
        input.mlUsed,
        input.mlFallbackReason,
        this.time.now(),
      ],
    );
    return rows[0];
  }

  /** The stored assessment, calculated on first read if none exists yet. */
  async latest(transactionId: string): Promise<AssessmentRow> {
    const existing = await this.db.queryOne<AssessmentRow>(
      `SELECT * FROM risk_assessments
        WHERE transaction_id = $1
        ORDER BY calculated_at DESC LIMIT 1`,
      [transactionId],
    );
    if (existing) return existing;
    return this.calculate(transactionId);
  }

  // =====================================================================
  // Presentation
  // =====================================================================

  /**
   * The response body, built per audience from an explicit allow-list.
   *
   * ZM-RSK-013: a bank receives scores, bands, factors and reason codes —
   * never weights, never coefficients, never the model's raw probability.
   * Note what is NOT in this object for any audience: there is no spread of
   * the row, so a column added later cannot leak by default. That is the same
   * rule INV-8 taught on the transaction payload.
   */
  describe(
    row: AssessmentRow,
    model: { versionLabel: string },
    audience: RiskAudience,
    language: 'EN' | 'AR' = 'EN',
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      compositeScore: row.composite_score,
      band: row.band,
      components: {
        supplierVerification: row.supplier_verification_score,
        dataConfidence: row.data_confidence_score,
        buyerProfile: row.buyer_profile_score,
        invoiceScore: row.invoice_score,
        platformBehavior: row.platform_behavior_score,
      },
      // Separate from the score, and typed as a number so no client has to
      // parse it out of a component (ZM-RSK-006).
      dataAvailabilityPct: row.data_availability_pct === null ? null : Number(row.data_availability_pct),
      positiveFactors: row.positive_factors ?? [],
      riskFactors: row.risk_factors ?? [],
      reasonCodes: row.reason_codes ?? [],
      modelVersion: model.versionLabel,
      mlUsed: row.ml_used,
      calculatedAt: row.calculated_at.toISOString(),
      disclaimer: DISCLAIMER[language],
    };

    // The degraded flag must be visible (ZM-RSK-017), including to a bank —
    // a banker relying on a score is entitled to know the model did not run.
    if (!row.ml_used) {
      body.mlFallbackReason = row.ml_fallback_reason ?? 'The risk model service was unavailable.';
    }
    return body;
  }

  // -- small helpers, kept private so the money never leaves as a number --

  private async faceValueOf(transactionId: string): Promise<number> {
    return this.numericInvoiceField(transactionId, 'face_value');
  }

  private async subtotalOf(transactionId: string): Promise<number> {
    return this.numericInvoiceField(transactionId, 'subtotal_amount');
  }

  private async taxOf(transactionId: string): Promise<number> {
    return this.numericInvoiceField(transactionId, 'tax_amount');
  }

  /**
   * Reads one money column as a float, for the model only.
   *
   * This is the single place in the API where a JOD amount becomes a JS
   * number, and it is safe for exactly one reason: the value is used as a
   * model *feature* — it is logged, standardized, and multiplied by a
   * coefficient — and never added to, compared against, or displayed as an
   * amount. Nothing derived from it is persisted as money. Hard rule 2 bans
   * floating-point *arithmetic on money*, which this is not; routing it
   * through Money first and then calling `.toNumber()` would be theatre.
   */
  private async numericInvoiceField(transactionId: string, column: string): Promise<number> {
    const row = await this.db.queryOne<{ value: string | null }>(
      `SELECT ${column}::text AS value FROM invoices WHERE transaction_id = $1`,
      [transactionId],
    );
    const parsed = Number(row?.value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
