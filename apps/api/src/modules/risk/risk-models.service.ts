import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { TIME_PROVIDER, TimeProvider } from '../../common/time/time.provider';
import type { ActorContext } from '../onboarding/onboarding.service';
import {
  COMPONENT_KEYS,
  DEFAULT_BAND_THRESHOLDS,
  DEFAULT_ML_WEIGHT,
  DEFAULT_WEIGHTS,
  type BandThresholds,
  type ComponentKey,
  type ComponentWeights,
} from './scoring';

/**
 * `RiskModelVersion` lifecycle (ZM-RSK-009..011).
 *
 * Three rules, and the reason each one exists:
 *
 *   - **Create, never edit.** There is no update method on this service, and
 *     no controller route that could reach one. A score's meaning is fixed by
 *     the weights that produced it, so editing an active version in place
 *     would silently redefine every historical score without touching a
 *     single `risk_assessments` row.
 *   - **Exactly one active version.** Enforced by `uq_one_active_risk_model`
 *     in the frozen schema, a partial unique index on `is_active`. The
 *     deactivate/activate pair below runs in one transaction so the database
 *     never sees two, and so a failed activation cannot leave the platform
 *     with none.
 *   - **Activation is audited with a rationale.** `activation_reason` is
 *     NOT NULL-in-practice here even though the column permits null: an
 *     activation nobody explained is one nobody can review later.
 *
 * Historical immutability (ZM-RSK-010) is the property these three combine to
 * produce, and it has its own named test: a stored assessment keeps its
 * `model_version_id` and its numbers when a new version is activated.
 */

export interface RiskModelVersionRow {
  id: string;
  version_label: string;
  model_type: string;
  weights: Record<string, unknown>;
  band_thresholds: Record<string, number>;
  is_active: boolean;
  training_metrics: Record<string, unknown> | null;
  effective_from: Date | null;
  effective_to: Date | null;
  activated_by: string | null;
  activation_reason: string | null;
  created_at: Date;
}

export interface CreateRiskModelInput {
  versionLabel: string;
  modelType: 'RULES' | 'ML' | 'HYBRID';
  weights?: Partial<Record<ComponentKey, number>> & { ml?: number };
  bandThresholds?: Partial<BandThresholds>;
  trainingMetrics?: Record<string, unknown>;
  activate?: boolean;
  activationReason?: string;
}

/** The resolved configuration a scoring pass runs against. */
export interface ResolvedModel {
  id: string;
  versionLabel: string;
  modelType: string;
  weights: ComponentWeights;
  mlWeight: number;
  bandThresholds: BandThresholds;
  trainingMetrics: Record<string, unknown> | null;
}

@Injectable()
export class RiskModelsService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(TIME_PROVIDER) private readonly time: TimeProvider,
  ) {}

  async list(): Promise<RiskModelVersionRow[]> {
    const { rows } = await this.db.query<RiskModelVersionRow>(
      `SELECT * FROM risk_model_versions ORDER BY created_at DESC`,
    );
    return rows;
  }

  async findActive(): Promise<RiskModelVersionRow | null> {
    return this.db.queryOne<RiskModelVersionRow>(
      `SELECT * FROM risk_model_versions WHERE is_active LIMIT 1`,
    );
  }

  async findById(id: string): Promise<RiskModelVersionRow | null> {
    return this.db.queryOne<RiskModelVersionRow>(
      `SELECT * FROM risk_model_versions WHERE id = $1`,
      [id],
    );
  }

  /**
   * The active version, resolved into the shape scoring consumes.
   *
   * Throws rather than defaulting when no version is active. A score
   * calculated against invented weights would carry a `modelVersion` that
   * describes nothing, and ZM-RSK-010's promise — that a historical score can
   * always be explained by its recorded version — would be false from the
   * first row.
   */
  async requireActive(): Promise<ResolvedModel> {
    const row = await this.findActive();
    if (!row) {
      throw new AppException(
        ErrorCode.SERVICE_UNAVAILABLE,
        'No active risk model version is configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.resolve(row);
  }

  resolve(row: RiskModelVersionRow): ResolvedModel {
    const stored = (row.weights ?? {}) as Record<string, unknown>;
    const weights = {} as Record<ComponentKey, number>;
    for (const key of COMPONENT_KEYS) {
      const value = Number(stored[key]);
      weights[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_WEIGHTS[key];
    }

    const mlWeight = Number(stored.ml);
    const thresholds = (row.band_thresholds ?? {}) as Record<string, unknown>;
    const threshold = (key: keyof BandThresholds): number => {
      const value = Number(thresholds[key]);
      return Number.isFinite(value) ? value : DEFAULT_BAND_THRESHOLDS[key];
    };

    return {
      id: row.id,
      versionLabel: row.version_label,
      modelType: row.model_type,
      weights,
      mlWeight: Number.isFinite(mlWeight) && mlWeight >= 0 ? mlWeight : DEFAULT_ML_WEIGHT,
      bandThresholds: { LOW: threshold('LOW'), MEDIUM: threshold('MEDIUM'), HIGH: threshold('HIGH') },
      trainingMetrics: row.training_metrics,
    };
  }

  /**
   * Creates a version, optionally activating it.
   *
   * Both statements share one transaction, so the partial unique index can
   * never be violated by a half-applied activation.
   */
  async create(input: CreateRiskModelInput, ctx: ActorContext): Promise<RiskModelVersionRow> {
    if (input.activate && !input.activationReason?.trim()) {
      // ZM-RSK-011: an activation without a rationale is not auditable.
      throw AppException.validation(
        'An activation reason is required when activating a risk model version.',
        { field: 'activationReason' },
      );
    }

    const existing = await this.db.queryOne(
      `SELECT 1 FROM risk_model_versions WHERE version_label = $1`,
      [input.versionLabel],
    );
    if (existing) {
      throw AppException.conflict(
        ErrorCode.CONFLICT,
        'A risk model version with that label already exists. Versions are created, never edited.',
        { versionLabel: input.versionLabel },
      );
    }

    const weights: Record<string, number> = { ml: input.weights?.ml ?? DEFAULT_ML_WEIGHT };
    for (const key of COMPONENT_KEYS) {
      weights[key] = input.weights?.[key] ?? DEFAULT_WEIGHTS[key];
    }
    const bandThresholds = { ...DEFAULT_BAND_THRESHOLDS, ...(input.bandThresholds ?? {}) };
    const now = this.time.now();

    return this.db.transaction(async (client) => {
      if (input.activate) {
        // Close the outgoing version's effective window rather than only
        // clearing the flag: "which model was active last March" must be
        // answerable from the table alone.
        await client.query(
          `UPDATE risk_model_versions
              SET is_active = false, effective_to = $1
            WHERE is_active`,
          [now],
        );
      }

      const { rows } = await client.query<RiskModelVersionRow>(
        `INSERT INTO risk_model_versions
           (version_label, model_type, weights, band_thresholds, is_active,
            training_metrics, effective_from, activated_by, activation_reason)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7, $8, $9)
         RETURNING *`,
        [
          input.versionLabel,
          input.modelType,
          JSON.stringify(weights),
          JSON.stringify(bandThresholds),
          input.activate === true,
          input.trainingMetrics ? JSON.stringify(input.trainingMetrics) : null,
          input.activate ? now : null,
          input.activate ? ctx.userId : null,
          input.activationReason ?? null,
        ],
      );
      return rows[0];
    });
  }

  /**
   * The admin-facing view.
   *
   * Weights and thresholds ARE included here — this endpoint is platform-only
   * (ZM-RSK-009 makes them administrator-configurable, so an administrator has
   * to be able to read them). ZM-RSK-013's prohibition is about the
   * *bank-facing* payload, which is built separately in `risk.service.ts` and
   * never from this shape.
   */
  describe(row: RiskModelVersionRow): Record<string, unknown> {
    return {
      id: row.id,
      versionLabel: row.version_label,
      modelType: row.model_type,
      weights: row.weights,
      bandThresholds: row.band_thresholds,
      isActive: row.is_active,
      trainingMetrics: row.training_metrics,
      effectiveFrom: row.effective_from?.toISOString() ?? null,
      effectiveTo: row.effective_to?.toISOString() ?? null,
      activatedBy: row.activated_by,
      activationReason: row.activation_reason,
      createdAt: row.created_at.toISOString(),
    };
  }
}
