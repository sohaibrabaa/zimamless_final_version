import { Client } from 'pg';

/**
 * `RiskModelVersion` lifecycle against the real database (ZM-RSK-009..011).
 *
 * These properties are enforced partly by the service and partly by the
 * schema's partial unique index, so testing them against a mock would test
 * the half that is easy. The index in particular — `uq_one_active_risk_model
 * ON risk_model_versions (is_active) WHERE is_active` — only exists in
 * Postgres, and "only one version can be active" is exactly the kind of claim
 * that holds in the service right up until two requests arrive together.
 *
 * The headline property is ZM-RSK-010: a stored assessment must keep its
 * numbers and its version when a new version is activated. A score a bank
 * relied on last month cannot change because the platform retuned its weights
 * this month.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error('DATABASE_URL is not set in CI. The risk version suite must run, not skip.');
}

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('risk model versions', () => {
  let db: Client;

  /** Fixed ids so teardown is exact and a re-run cannot accumulate. */
  const FIX = {
    versionA: '0e500000-0000-4000-8000-000000000001',
    versionB: '0e500000-0000-4000-8000-000000000002',
    assessment: '0e500000-0000-4000-8000-000000000003',
    tx: '0e500000-0000-4000-8000-000000000004',
  };
  const AL_NOOR_ORG = '0e000000-0000-4000-8000-000000000002';
  const AL_NOOR_USER = '0e100000-0000-4000-8000-000000000001';

  const cleanup = async (): Promise<void> => {
    await db.query('DELETE FROM risk_assessments WHERE id = $1', [FIX.assessment]);
    await db.query('DELETE FROM receivable_transactions WHERE id = $1', [FIX.tx]);
    await db.query('DELETE FROM risk_model_versions WHERE id = ANY($1::uuid[])', [
      [FIX.versionA, FIX.versionB],
    ]);
  };

  beforeAll(async () => {
    db = new Client({
      connectionString,
      ssl: /supabase\.(com|co)/.test(connectionString!) ? { rejectUnauthorized: false } : undefined,
    });
    await db.connect();
    await cleanup();
  });

  afterAll(async () => {
    if (db) {
      await cleanup().catch(() => undefined);
      await db.end();
    }
  });

  it('ships exactly one active version', async () => {
    // Migration 0006 installs the baseline. Without an active version the
    // service refuses to score rather than inventing weights, so this is a
    // precondition for the whole feature rather than a nicety.
    const { rows } = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM risk_model_versions WHERE is_active',
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('refuses a second active version at the database level', async () => {
    await db.query(
      `INSERT INTO risk_model_versions (id, version_label, model_type, weights, is_active)
       VALUES ($1, 'test-second-active', 'RULES', '{}'::jsonb, true)`,
      [FIX.versionA],
    ).then(
      () => {
        throw new Error(
          'A second active risk model version was accepted. uq_one_active_risk_model is missing ' +
            'or no longer partial — every score would become ambiguous about which weights made it.',
        );
      },
      (err: Error) => {
        expect(err.message).toMatch(/uq_one_active_risk_model|duplicate key/i);
      },
    );
  });

  it('keeps a historical assessment unchanged when a new version is activated (ZM-RSK-010)', async () => {
    // Arrange: a transaction, a version, and an assessment calculated
    // against it. Written directly because the claim under test is about
    // what happens to a STORED row — the path that produced it is the
    // journey suite's subject, not this one's.
    await db.query(
      `INSERT INTO receivable_transactions (id, reference_number, supplier_org_id, state, created_by)
       VALUES ($1, 'ZM-RISKVER-FIXTURE', $2, 'ELIGIBLE', $3)`,
      [FIX.tx, AL_NOOR_ORG, AL_NOOR_USER],
    );
    await db.query(
      `INSERT INTO risk_model_versions
         (id, version_label, model_type, weights, band_thresholds, is_active)
       VALUES ($1, 'test-historical-v1', 'RULES',
               '{"invoiceScore":1.0}'::jsonb, '{"LOW":75,"MEDIUM":50,"HIGH":25}'::jsonb, false)`,
      [FIX.versionA],
    );
    await db.query(
      `INSERT INTO risk_assessments
         (id, transaction_id, organization_id, model_version_id, composite_score, band,
          invoice_score, data_availability_pct, ml_used)
       VALUES ($1, $2, $3, $4, 82, 'LOW', 90, 75.00, true)`,
      [FIX.assessment, FIX.tx, AL_NOOR_ORG, FIX.versionA],
    );

    const before = await db.query(
      'SELECT composite_score, band, invoice_score, model_version_id FROM risk_assessments WHERE id = $1',
      [FIX.assessment],
    );

    // Act: a new version arrives with radically different weights and is
    // activated, exactly as `RiskModelsService.create` does it.
    await db.query('BEGIN');
    await db.query('UPDATE risk_model_versions SET is_active = false, effective_to = now() WHERE is_active');
    await db.query(
      `INSERT INTO risk_model_versions
         (id, version_label, model_type, weights, band_thresholds, is_active,
          activated_by, activation_reason, effective_from)
       VALUES ($1, 'test-historical-v2', 'RULES',
               '{"invoiceScore":0.1,"buyerProfile":0.9}'::jsonb,
               '{"LOW":95,"MEDIUM":90,"HIGH":85}'::jsonb, true, $2,
               'Retuned for the immutability test', now())`,
      [FIX.versionB, AL_NOOR_USER],
    );
    await db.query('COMMIT');

    // Assert: the stored assessment did not move — not its score, not its
    // band (despite thresholds that would now put 82 in CRITICAL), and not
    // the version it points at.
    const after = await db.query(
      'SELECT composite_score, band, invoice_score, model_version_id FROM risk_assessments WHERE id = $1',
      [FIX.assessment],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0].band).toBe('LOW');
    expect(after.rows[0].model_version_id).toBe(FIX.versionA);

    // Restore the baseline as the active version, or every later suite scores
    // against the throwaway one.
    await db.query('BEGIN');
    await db.query('UPDATE risk_model_versions SET is_active = false WHERE is_active');
    await db.query(
      `UPDATE risk_model_versions SET is_active = true, effective_to = NULL
        WHERE version_label = 'risk-logreg-1.0+seed20260723'`,
    );
    await db.query('COMMIT');
  });

  it('records an activation rationale with its actor (ZM-RSK-011)', async () => {
    const { rows } = await db.query<{
      activation_reason: string | null;
      activated_by: string | null;
      effective_from: Date | null;
    }>(
      `SELECT activation_reason, activated_by, effective_from
         FROM risk_model_versions WHERE id = $1`,
      [FIX.versionB],
    );
    expect(rows[0].activation_reason).toBeTruthy();
    expect(rows[0].activated_by).toBe(AL_NOOR_USER);
    expect(rows[0].effective_from).not.toBeNull();
  });

  it('leaves the baseline version active after this suite', async () => {
    const { rows } = await db.query<{ version_label: string }>(
      'SELECT version_label FROM risk_model_versions WHERE is_active',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].version_label).toBe('risk-logreg-1.0+seed20260723');
  });
});
