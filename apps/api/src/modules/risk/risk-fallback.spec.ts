import { RiskModelClientService } from './risk-model-client.service';
import { blendWithModel, DEFAULT_ML_WEIGHT } from './scoring';
import { RiskService } from './risk.service';
import { capForBlockers } from './rules-engine';

/**
 * ZM-RSK-017 — the rules-only fallback, and the visibility of it.
 *
 * The requirement has two halves and the second is the one that gets
 * forgotten: falling back gracefully is easy, but a fallback nobody can SEE
 * means a demo runs for an hour on degraded scores with the model container
 * dead and no one the wiser. So every test here checks both that the score
 * still comes out and that the degradation is stated.
 */

const config = { ml: { url: 'http://127.0.0.1:9', timeoutMs: 200 } } as never;

describe('RiskModelClientService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns the degraded shape rather than throwing when the service is down', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as never;

    const result = await new RiskModelClientService(config).score({} as never);

    expect(result.modelAvailable).toBe(false);
    expect(result.riskProbability).toBeNull();
    // The reason is the thing that reaches mlFallbackReason and then the UI.
    expect(result.unavailableReason).toContain('could not be reached');
  });

  it('treats a non-200 as unavailable rather than parsing the body', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as never;

    const result = await new RiskModelClientService(config).score({} as never);

    expect(result.modelAvailable).toBe(false);
    expect(result.unavailableReason).toContain('503');
  });

  it('treats a 200 that carries no usable model as unavailable', async () => {
    // The service answers, and honestly reports it has no artifact loaded.
    // A client that only checked the HTTP status would score on nulls.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        modelAvailable: false,
        unavailableReason: 'No trained model artifact is present.',
        riskProbability: null,
      }),
    }) as never;

    const result = await new RiskModelClientService(config).score({} as never);

    expect(result.modelAvailable).toBe(false);
    expect(result.unavailableReason).toBe('No trained model artifact is present.');
  });

  it('accepts a healthy response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        modelAvailable: true,
        riskProbability: 0.2,
        modelVersion: 'risk-logreg-1.0',
        contributions: [{ feature: 'tenor_days', label: 'x', contribution: 0.1, direction: 'INCREASES_RISK' }],
        synthetic: true,
      }),
    }) as never;

    const result = await new RiskModelClientService(config).score({} as never);

    expect(result.modelAvailable).toBe(true);
    expect(result.riskProbability).toBe(0.2);
    expect(result.synthetic).toBe(true);
  });

  it('assumes synthetic when the service does not say otherwise', async () => {
    // ZM-RSK-016 fails safe: an unlabelled model is treated as synthetic, so
    // a missing flag understates confidence rather than overstating it.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ modelAvailable: true, riskProbability: 0.3 }),
    }) as never;

    expect((await new RiskModelClientService(config).score({} as never)).synthetic).toBe(true);
  });
});

describe('blending the model into the composite', () => {
  it('moves the score toward the model but leaves the rules in charge', () => {
    // A confident "this is fine" from the model lifts a mediocre rules score,
    // but only by its minority share.
    const lifted = blendWithModel(60, 0.0, DEFAULT_ML_WEIGHT);
    expect(lifted).toBe(70); // 0.75*60 + 0.25*100

    const lowered = blendWithModel(60, 1.0, DEFAULT_ML_WEIGHT);
    expect(lowered).toBe(45); // 0.75*60 + 0.25*0
  });

  it('is a no-op at zero weight', () => {
    expect(blendWithModel(63, 0.9, 0)).toBe(63);
  });

  it('cannot lift a blocked transaction out of CRITICAL (ZM-RSK-015)', () => {
    // The ordering guarantee, stated as arithmetic: blend first, cap last.
    const blockers = [{ code: 'BLOCK_DUPLICATE_INVOICE', detail: '' }];
    const blended = blendWithModel(90, 0.0, DEFAULT_ML_WEIGHT);
    expect(blended).toBeGreaterThan(75);
    expect(capForBlockers(blended, blockers)).toBeLessThan(25);
  });
});

describe('the bank-facing payload (ZM-RSK-013)', () => {
  const row = {
    id: 'a',
    transaction_id: 't',
    organization_id: 'o',
    model_version_id: 'm',
    composite_score: 81,
    band: 'LOW' as const,
    supplier_verification_score: 90,
    data_confidence_score: 70,
    buyer_profile_score: 85,
    invoice_score: 88,
    platform_behavior_score: 75,
    data_availability_pct: '82.50',
    positive_factors: ['POS_BUYER_ACTIVE_REGISTRY'],
    risk_factors: ['RISK_NEW_BUYER_RELATIONSHIP'],
    reason_codes: ['RISK_NEW_BUYER_RELATIONSHIP'],
    ml_used: true,
    ml_fallback_reason: null,
    calculated_at: new Date('2026-07-23T09:00:00Z'),
  };

  // Only `describe` is exercised, so the service's dependencies are not
  // needed — constructing with nulls keeps the test about the payload.
  const service = new RiskService(
    null as never, null as never, null as never,
    null as never, null as never, null as never, null as never,
  );

  it('gives a bank the score and factors', () => {
    const body = service.describe(row, { versionLabel: 'v1' }, 'BANK');

    expect(body.compositeScore).toBe(81);
    expect(body.band).toBe('LOW');
    expect(body.riskFactors).toEqual(['RISK_NEW_BUYER_RELATIONSHIP']);
    expect(body.modelVersion).toBe('v1');
  });

  it('gives a bank no weights, coefficients or model internals', () => {
    const serialized = JSON.stringify(service.describe(row, { versionLabel: 'v1' }, 'BANK'));

    for (const forbidden of [
      'weights', 'coefficients', 'intercept', 'means', 'stds',
      'riskProbability', 'contributions', 'trainingMetrics',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('reports dataAvailabilityPct as a number, separate from the score', () => {
    // ZM-RSK-006: separate field, numeric, so no client has to derive it
    // from a component — deriving is how it ends up styled as a warning.
    const body = service.describe(row, { versionLabel: 'v1' }, 'BANK');
    expect(body.dataAvailabilityPct).toBe(82.5);
    expect(body.compositeScore).not.toBe(body.dataAvailabilityPct);
  });

  it('carries the disclaimer in the caller’s language (ZM-RSK-002)', () => {
    const en = service.describe(row, { versionLabel: 'v1' }, 'BANK', 'EN');
    const ar = service.describe(row, { versionLabel: 'v1' }, 'BANK', 'AR');

    expect(String(en.disclaimer)).toContain('decision support only');
    expect(String(ar.disclaimer)).toContain('دعم القرار');
    expect(en.disclaimer).not.toBe(ar.disclaimer);
  });

  it('shows the degraded flag and its reason when the model did not run', () => {
    const degraded = service.describe(
      { ...row, ml_used: false, ml_fallback_reason: 'The risk model service was unreachable.' },
      { versionLabel: 'v1' },
      'BANK',
    );

    expect(degraded.mlUsed).toBe(false);
    // A banker relying on the number is entitled to know the model was down.
    expect(degraded.mlFallbackReason).toContain('unreachable');
  });

  it('never omits the degraded reason, even if the column is null', () => {
    const degraded = service.describe(
      { ...row, ml_used: false, ml_fallback_reason: null },
      { versionLabel: 'v1' },
      'BANK',
    );
    expect(degraded.mlFallbackReason).toBeTruthy();
  });

  it('omits the fallback field entirely when the model did run', () => {
    const healthy = service.describe(row, { versionLabel: 'v1' }, 'BANK');
    expect('mlFallbackReason' in healthy).toBe(false);
  });
});
