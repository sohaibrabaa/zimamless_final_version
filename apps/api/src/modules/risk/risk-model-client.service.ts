import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/configuration';

/**
 * Client for the ML service's risk endpoint.
 *
 * Same posture as `documents/ml-client.service.ts`: the service is fallible
 * infrastructure, this client never throws, and the degraded result has the
 * same shape as the healthy one so the caller has a single code path.
 *
 * ZM-RSK-017 requires the fallback to be *visible*, not merely graceful — so
 * `unavailableReason` is always populated when `modelAvailable` is false, and
 * it is carried all the way to `mlFallbackReason` on the stored assessment
 * and the API response. A silent fallback would let a demo run for an hour on
 * rules-only scores with nobody noticing the model container had died.
 */

export interface MlFeatureContribution {
  feature: string;
  label: string;
  /** Signed log-odds. Positive pushes toward "goes bad". */
  contribution: number;
  direction: 'INCREASES_RISK' | 'DECREASES_RISK';
}

export interface MlRiskResult {
  modelAvailable: boolean;
  unavailableReason: string | null;
  modelVersion: string | null;
  riskProbability: number | null;
  contributions: MlFeatureContribution[];
  /** ZM-RSK-016 — travels with the prediction, never inferred by the caller. */
  synthetic: boolean;
}

/** The always-known facts the model scores on. See `features.py`. */
export interface MlRiskRequest {
  tenorDays: number;
  faceValue: number;
  subtotalAmount: number;
  taxAmount: number;
  completenessRatio: number;
  duplicateCollision: boolean;
  electronicInvoiceAttached: boolean;
  partiallyPaid: boolean;
  priorSubmittedCount: number;
  disputeCount: number;
  duplicateReferralCount: number;
  recourseCount: number;
}

@Injectable()
export class RiskModelClientService {
  private readonly logger = new Logger(RiskModelClientService.name);

  constructor(private readonly config: AppConfig) {}

  async score(request: MlRiskRequest): Promise<MlRiskResult> {
    const url = `${this.config.ml.url.replace(/\/+$/, '')}/risk/score`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        // Scoring is arithmetic on eleven numbers — if it has not answered
        // in the configured budget the service is not busy, it is gone.
        signal: AbortSignal.timeout(this.config.ml.timeoutMs),
      });

      if (!response.ok) {
        return this.unavailable(`The risk model service returned ${response.status}.`);
      }

      const body = (await response.json()) as Partial<MlRiskResult>;
      if (body.modelAvailable !== true || typeof body.riskProbability !== 'number') {
        return this.unavailable(
          body.unavailableReason ?? 'The risk model service reported no usable model.',
        );
      }

      return {
        modelAvailable: true,
        unavailableReason: null,
        modelVersion: body.modelVersion ?? null,
        riskProbability: body.riskProbability,
        contributions: body.contributions ?? [],
        synthetic: body.synthetic !== false,
      };
    } catch (err) {
      const message =
        (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError'
          ? `The risk model service did not respond within ${this.config.ml.timeoutMs}ms.`
          : `The risk model service could not be reached: ${(err as Error).message}`;
      this.logger.warn(message);
      return this.unavailable(message);
    }
  }

  private unavailable(reason: string): MlRiskResult {
    return {
      modelAvailable: false,
      unavailableReason: reason,
      modelVersion: null,
      riskProbability: null,
      contributions: [],
      synthetic: true,
    };
  }
}
