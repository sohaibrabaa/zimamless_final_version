import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { AppConfig } from '../src/config/configuration';
import { SystemTimeProvider } from '../src/common/time/time.provider';
import { StorageService } from '../src/modules/documents/storage.service';
import { RiskService } from '../src/modules/risk/risk.service';
import { unavailable } from '../src/modules/risk/facts';
import { allComponents, dataAvailabilityPct } from '../src/modules/risk/scoring';

/**
 * Phase 3 supplier journey, end to end, against real infrastructure.
 *
 * This is the Phase 3 integration checkpoint as a runnable gate rather than a
 * script someone remembers to run. It drives the whole wizard through the real
 * API — buyer search → resolve → draft → upload → real OCR → invoice → floor →
 * declarations → submit → ELIGIBLE — plus the duplicate-fingerprint block and
 * the signed-URL authorization drill.
 *
 * What is real here, and deliberately not mocked:
 *
 *   - Postgres. The hosted database, with RLS on and the seed loaded.
 *   - Supabase Auth. Every request carries a token minted by a real password
 *     login, verified by the real guard against the real JWKS.
 *   - Supabase Storage. The PDF is PUT to a signed URL and read back by the
 *     server, so an expired or wrongly-scoped URL fails here rather than in a
 *     demo.
 *   - The OCR service. It rasterizes and reads pixels; the assertions below
 *     are about what a real engine returned, which is why they tolerate
 *     confidence rather than demanding an exact transcript.
 *
 * The one thing stubbed out is nothing at all. That is the point: every defect
 * this suite has caught so far — the timezone day-shift, the duplicate index
 * defeating its own check — produced *plausible* output and was invisible to
 * unit tests.
 *
 * Preconditions are asserted loudly in beforeAll. A missing ML service or an
 * unseeded database must fail with an instruction, not with a confusing
 * assertion error twenty lines down.
 *
 * Run with:  npm run test:integration -w @zimmamless/api
 */

const connectionString = process.env.DATABASE_URL;
const SUPABASE = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY ?? '';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Zimmamless#2026';
const ML_URL = (process.env.ML_SERVICE_URL ?? 'http://localhost:8000').replace(/\/+$/, '');

if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. The Phase 3 journey is a required gate — ' +
      'it must run, not skip.',
  );
}

const describeIfDb = connectionString && SUPABASE && ANON ? describe : describe.skip;

/**
 * Invoice numbers this suite owns. The happy path MUST use the number printed
 * on the seeded PDF, because one of the eight checks compares the typed
 * invoice against what OCR read — so a per-run unique number would make the
 * journey fail for the wrong reason. That forces real cleanup: the duplicate
 * index is platform-wide over active invoices, so yesterday's run would
 * otherwise block today's first submit.
 */
const OWNED_INVOICE_NUMBERS = ['INV-2026-0001', 'inv 2026 0001', 'INV-2026-0004'];

describeIfDb('Phase 3 — supplier journey against real infrastructure', () => {
  let app: INestApplication;
  let db: Client;
  let prefix: string;

  /** Transactions this run created, for precise teardown. */
  const created: string[] = [];

  const tokens: Record<string, string> = {};
  const orgs: Record<string, string> = {};

  let buyerId: string;
  let txId: string;
  let documentId: string;

  // -------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------

  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error(
        `Could not log in as ${email}. Is db/seed/0100_seed_dev.sql loaded and are the ` +
          'auth users created? (SEED_USER_PASSWORD overrides the default.)',
      );
    }
    return body.access_token;
  };

  type ApiResponse = { status: number; body: any };

  const api = async (
    persona: string,
    method: 'get' | 'post' | 'put',
    path: string,
    body?: unknown,
  ): Promise<ApiResponse> => {
    let req = request(app.getHttpServer())[method](`${prefix}${path}`)
      .set('Authorization', `Bearer ${tokens[persona]}`)
      .set('X-Organization-Id', orgs[persona]);
    if (body !== undefined) req = req.send(body as object);
    const res = await req;
    return { status: res.status, body: res.body };
  };

  /**
   * Deletes transactions and everything hanging off them, child-first.
   *
   * The list is explicit rather than a cascade because the frozen schema
   * declares plain REFERENCES: if a later phase adds a writer that points at
   * receivable_transactions, this delete fails on a foreign key and someone
   * has to come update it. A silent cascade would instead delete the new rows
   * and never mention it.
   */
  const purge = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    await db.query('BEGIN');
    try {
      await db.query(
        `DELETE FROM verification_checks WHERE run_id IN
           (SELECT id FROM verification_runs WHERE transaction_id = ANY($1::uuid[]))`,
        [ids],
      );
      await db.query('DELETE FROM verification_runs WHERE transaction_id = ANY($1::uuid[])', [ids]);
      await db.query('DELETE FROM risk_assessments WHERE transaction_id = ANY($1::uuid[])', [ids]);
      await db.query(
        `DELETE FROM fraud_indicators WHERE fraud_case_id IN
           (SELECT id FROM fraud_cases WHERE transaction_id = ANY($1::uuid[]))`,
        [ids],
      );
      await db.query('DELETE FROM fraud_cases WHERE transaction_id = ANY($1::uuid[])', [ids]);
      await db.query(
        `DELETE FROM invoice_items WHERE invoice_id IN
           (SELECT id FROM invoices WHERE transaction_id = ANY($1::uuid[]))`,
        [ids],
      );
      await db.query('DELETE FROM invoice_declarations WHERE transaction_id = ANY($1::uuid[])', [ids]);
      await db.query('DELETE FROM invoices WHERE transaction_id = ANY($1::uuid[])', [ids]);
      await db.query(
        `DELETE FROM document_extractions WHERE document_id IN
           (SELECT id FROM documents WHERE subject_type = 'TRANSACTION' AND subject_id = ANY($1::uuid[]))`,
        [ids],
      );
      await db.query(
        `DELETE FROM documents WHERE subject_type = 'TRANSACTION' AND subject_id = ANY($1::uuid[])`,
        [ids],
      );
      await db.query(
        `DELETE FROM status_history WHERE entity_type = 'TRANSACTION' AND entity_id = ANY($1::uuid[])`,
        [ids],
      );
      await db.query('DELETE FROM notifications WHERE transaction_id = ANY($1::uuid[])', [ids]);
      // audit_logs is deliberately NOT touched. It holds no foreign key to
      // receivable_transactions — target_entity_id is loose precisely so the
      // trail outlives what it describes — and deleting audit entries to tidy
      // up after a test would contradict the invariant the trail exists for.
      await db.query('DELETE FROM receivable_transactions WHERE id = ANY($1::uuid[])', [ids]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  };

  // -------------------------------------------------------------------
  // preconditions and boot
  // -------------------------------------------------------------------

  beforeAll(async () => {
    // The OCR service is not optional for this suite. The ML client degrades
    // rather than throwing — correct in production, useless here, because a
    // stopped service would turn into a soft "extraction unavailable" and the
    // OCR assertions would fail with no hint as to why.
    let health: { ocrEngineAvailable?: boolean };
    try {
      health = (await fetch(`${ML_URL}/health`).then((r) => r.json())) as typeof health;
    } catch {
      throw new Error(
        `The document service is not reachable at ${ML_URL}. Start it first:\n` +
          '  cd services/ml && py -m uvicorn app.main:app --port 8000',
      );
    }
    if (!health.ocrEngineAvailable) {
      throw new Error(
        `The document service is up at ${ML_URL} but reports no OCR engine. ` +
          'Reinstall services/ml/requirements.txt.',
      );
    }

    db = new Client({
      connectionString,
      ssl: /supabase\.(com|co)/.test(connectionString!) ? { rejectUnauthorized: false } : undefined,
    });
    await db.connect();

    // Residue from a previous run — including one that crashed mid-journey —
    // holds the platform-wide fingerprint index and would block this run's
    // first submit with a duplicate that has nothing to do with this run.
    const { rows } = await db.query<{ transaction_id: string }>(
      'SELECT transaction_id FROM invoices WHERE invoice_number = ANY($1::text[])',
      [OWNED_INVOICE_NUMBERS],
    );
    await purge(rows.map((r) => r.transaction_id));

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });

    // Mirror main.ts exactly. A test app configured more loosely than the real
    // one proves nothing about the real one — the validation pipe in
    // particular is where several of the contract's 400s come from.
    const config = app.get(AppConfig);
    prefix = `/${config.globalPrefix}`;
    app.setGlobalPrefix(config.globalPrefix, { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.get(SystemTimeProvider).refresh();
    await app.get(StorageService).ensureBucket();
    await app.init();

    for (const [persona, email] of [
      ['supplier', 'owner@alnoor.zimmamless.test'],
      ['petra', 'owner@petra.zimmamless.test'],
      ['bank', 'maker@jnb.zimmamless.test'],
    ] as const) {
      tokens[persona] = await login(email);
      const me = await request(app.getHttpServer())
        .get(`${prefix}/auth/me`)
        .set('Authorization', `Bearer ${tokens[persona]}`);
      orgs[persona] = me.body.memberships[0].organizationId;
    }
  }, 180_000);

  afterAll(async () => {
    // Precise teardown: only what this run created, by id. Leaving the rows
    // behind would block the next run on the fingerprint index, and deleting
    // by a looser predicate would risk someone else's data on a shared
    // development database.
    if (db) {
      await purge(created).catch(() => undefined);
      await db.end();
    }
    await app?.close();
  });

  // -------------------------------------------------------------------
  // buyer resolution
  // -------------------------------------------------------------------

  describe('buyer resolution', () => {
    it('personas resolve to distinct organizations', () => {
      expect(orgs.supplier).toBeTruthy();
      expect(orgs.petra).toBeTruthy();
      expect(orgs.bank).toBeTruthy();
      expect(new Set(Object.values(orgs)).size).toBe(3);
    });

    it('search returns candidates and never a selection (ZM-BUY-009)', async () => {
      const res = await api('supplier', 'get', '/buyers/search?q=30000201');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.candidates)).toBe(true);
      expect(res.body.candidates.length).toBeGreaterThanOrEqual(1);
      // The absence assertions are the substance: a search that pre-selects
      // is the failure ZM-BUY-009 names.
      expect(res.body).not.toHaveProperty('selectedBuyerId');
      expect(res.body).not.toHaveProperty('selected');
    });

    it('refuses a SUSPENDED buyer with 409 BUYER_BLOCKED', async () => {
      const res = await api('supplier', 'post', '/buyers/resolve', {
        nationalEstablishmentNumber: '30000204',
        confirmedByUser: true,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUYER_BLOCKED');
    });

    it('refuses a STRUCK_OFF buyer with 409 BUYER_BLOCKED', async () => {
      const res = await api('supplier', 'post', '/buyers/resolve', {
        nationalEstablishmentNumber: '30000205',
        confirmedByUser: true,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('BUYER_BLOCKED');
    });

    it('sends UNDER_LIQUIDATION to manual review rather than blocking it (LT-02)', async () => {
      const res = await api('supplier', 'post', '/buyers/resolve', {
        nationalEstablishmentNumber: '30000206',
        confirmedByUser: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.requiresManualReview).toBe(true);
    });

    it('refuses to resolve without explicit user confirmation (ZM-BUY-009)', async () => {
      const res = await api('supplier', 'post', '/buyers/resolve', {
        nationalEstablishmentNumber: '30000201',
        confirmedByUser: false,
      });
      expect(res.status).toBe(422);
    });

    it('links the buyer and keeps contact data off the buyer payload (ZM-BUY-005/008)', async () => {
      const res = await api('supplier', 'post', '/buyers/resolve', {
        nationalEstablishmentNumber: '30000201',
        confirmedByUser: true,
        contact: {
          contactName: 'Nour Salti',
          contactRole: 'Accounts payable',
          contactPhone: '+962790000111',
          contactEmail: 'ap@ammanretail.example',
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBeTruthy();
      buyerId = res.body.id;

      // Contact belongs to the relationship, never to the shared buyer row —
      // two suppliers hold different contacts for the same buyer.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('Nour Salti');
      expect(serialized).not.toContain('962790000111');
    });
  });

  // -------------------------------------------------------------------
  // document upload and extraction
  // -------------------------------------------------------------------

  describe('document upload and real OCR', () => {
    it('creates a draft transaction with a reference number', async () => {
      const res = await api('supplier', 'post', '/transactions');
      expect(res.status).toBe(201);
      expect(res.body.referenceNumber).toMatch(/^ZM-\d+$/);
      txId = res.body.id;
      created.push(txId);
    });

    it('issues a signed upload URL and accepts the file straight to storage', async () => {
      const pdf = readFileSync(
        join(__dirname, '..', '..', '..', 'db', 'seed', 'einvoices',
          'INV-2026-0001-alnoor-amman-retail.pdf'),
      );

      const res = await api('supplier', 'post', '/documents/upload-url', {
        documentType: 'ELECTRONIC_INVOICE',
        fileName: 'INV-2026-0001.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdf.length,
        subjectType: 'TRANSACTION',
        subjectId: txId,
      });
      expect(res.status).toBe(200);
      expect(res.body.uploadUrl).toBeTruthy();
      expect(res.body.expiresAt).toBeTruthy();
      documentId = res.body.documentId;

      // The browser's PUT, made here for real. The service-role key never
      // takes part: this URL is all the client ever gets.
      const put = await fetch(res.body.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: new Uint8Array(pdf),
      });
      expect(put.ok).toBe(true);
    }, 120_000);

    it('runs genuine OCR over the uploaded pixels and pre-fills the invoice', async () => {
      const res = await api('supplier', 'get', `/documents/${documentId}/extraction`);
      expect(res.status).toBe(200);
      expect(res.body.ocr.confidence).toBeGreaterThan(0.5);

      const fields = res.body.ocr.extractedFields;
      expect(fields.invoiceNumber).toBe('INV-2026-0001');
      expect(fields.faceValue).toBe('12354.000');
    }, 120_000);

    it('decodes the QR locally and validates it', async () => {
      const res = await api('supplier', 'get', `/documents/${documentId}/extraction`);
      expect(res.body.qr.validationStatus).toBe('VALID');
      expect(res.body.qr.extractedFields.einvoiceIdentifier).toBe('JO-EINV-20000101-0001');
    });

    it('preserves raw machine output independently of user corrections (ZM-DOC-006)', async () => {
      const res = await api('supplier', 'get', `/documents/${documentId}/extraction`);
      expect(Array.isArray(res.body.ocr.rawOutput.lines)).toBe(true);
      expect(res.body.ocr.rawOutput.lines.length).toBeGreaterThan(5);
    });
  });

  // -------------------------------------------------------------------
  // signed-URL authorization
  // -------------------------------------------------------------------

  describe('document authorization (ZM-DOC-004)', () => {
    it('gives a bank 404, not 403, for a supplier document', async () => {
      const res = await api('bank', 'get', `/documents/${documentId}/download-url`);
      // 404 rather than 403 on purpose: 403 confirms the id exists and turns
      // the endpoint into an enumeration oracle.
      expect(res.status).toBe(404);
    });

    it('gives another supplier 404 as well', async () => {
      const res = await api('petra', 'get', `/documents/${documentId}/download-url`);
      expect(res.status).toBe(404);
    });

    it('gives the owning supplier a short-lived signed URL', async () => {
      const res = await api('supplier', 'get', `/documents/${documentId}/download-url`);
      expect(res.status).toBe(200);
      expect(res.body.url).toBeTruthy();
      expect(res.body.expiresAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------
  // invoice, floor, declarations
  // -------------------------------------------------------------------

  describe('invoice and the private floor', () => {
    it('saves the invoice with a server-recomputed outstanding amount', async () => {
      const res = await api('supplier', 'put', `/transactions/${txId}/invoice`, {
        invoiceNumber: 'INV-2026-0001',
        einvoiceIdentifier: 'JO-EINV-20000101-0001',
        issueDate: '2026-05-10',
        dueDate: '2026-08-10',
        subtotalAmount: '10650.000',
        taxAmount: '1704.000',
        faceValue: '12354.000',
        paidAmount: '0.000',
        paymentTerms: 'Net 90 days',
        purchaseOrderNumber: 'PO-AR-88120',
      });
      expect(res.status).toBe(200);
      // Recomputed by the server from face - paid, never trusted from input.
      expect(res.body.outstandingAmount).toBe('12354.000');
      // Dates come back as they were typed. This is where the Asia/Amman
      // day-shift showed up: a date column read as a JS Date lands on local
      // midnight and toISOString() rolls it back a day.
      expect(res.body.issueDate).toBe('2026-05-10');
      expect(res.body.dueDate).toBe('2026-08-10');
    });

    it('links the buyer to the transaction', async () => {
      const res = await api('supplier', 'put', `/transactions/${txId}/buyer`, { buyerId });
      expect(res.status).toBe(200);
    });

    it('refuses a floor above the outstanding amount without echoing it back', async () => {
      const res = await api('supplier', 'put', `/transactions/${txId}/minimum-amount`, {
        minimumAcceptableAmount: '99999.000',
      });
      expect(res.status).toBe(422);
      // INV-8 holds in error paths too: the floor must not appear in any
      // payload that could reach a bank, and errors get forwarded.
      expect(JSON.stringify(res.body)).not.toContain('99999');
    });

    it('accepts a valid floor', async () => {
      const res = await api('supplier', 'put', `/transactions/${txId}/minimum-amount`, {
        minimumAcceptableAmount: '11000.000',
      });
      expect(res.status).toBe(200);
    });

    it('records the eight declarations', async () => {
      const res = await api('supplier', 'post', `/transactions/${txId}/declarations`, {
        declarationTemplateVersion: '1.0',
        isAuthentic: true,
        goodsDelivered: true,
        unpaidAndNotCancelled: true,
        noKnownDispute: true,
        notPreviouslyFinanced: true,
        buyerIsNamedEntity: true,
        contactIsBuyerRep: true,
        acceptsRecourse: true,
      });
      expect(res.status).toBe(201);
    });

    it('refuses a false declaration with 422, not a shape error', async () => {
      const res = await api('supplier', 'post', `/transactions/${txId}/declarations`, {
        declarationTemplateVersion: '1.0',
        isAuthentic: false,
        goodsDelivered: true,
        unpaidAndNotCancelled: true,
        noKnownDispute: true,
        notPreviouslyFinanced: true,
        buyerIsNamedEntity: true,
        contactIsBuyerRep: true,
        acceptsRecourse: true,
      });
      // 422 with details.notAffirmed, not 400: refusing to affirm is a
      // business decision the supplier made, not a malformed request.
      expect(res.status).toBe(422);
      expect(res.body.details.notAffirmed).toContain('isAuthentic');
    });
  });

  // -------------------------------------------------------------------
  // submit and verification
  // -------------------------------------------------------------------

  describe('submission', () => {
    it('reaches ELIGIBLE', async () => {
      const res = await api('supplier', 'post', `/transactions/${txId}/submit`);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('ELIGIBLE');
    }, 120_000);

    it('records all eight checks with an overall PASS', async () => {
      const res = await api('supplier', 'get', `/transactions/${txId}/verification`);
      expect(res.body.checks).toHaveLength(8);
      expect(res.body.overallResult).toBe('PASS');
    });

    it('shows the floor to its owner and the transaction to nobody else (INV-8)', async () => {
      const own = await api('supplier', 'get', `/transactions/${txId}`);
      expect(own.body.minimumAcceptableAmount).toBe('11000.000');

      // Nothing is listed to banks until Phase 5, so this is 404 rather than
      // a redacted payload — the strongest form the invariant can take today.
      const bank = await api('bank', 'get', `/transactions/${txId}`);
      expect(bank.status).toBe(404);

      const other = await api('petra', 'get', `/transactions/${txId}`);
      expect(other.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // Phase 4 — the Trust Score, on the eligible transaction above
  // -------------------------------------------------------------------

  describe('Trust Score (Phase 4 integration checkpoint)', () => {
    it('scores the eligible transaction with components and factors', async () => {
      const res = await api('supplier', 'get', `/transactions/${txId}/risk`);

      expect(res.status).toBe(200);
      expect(res.body.compositeScore).toBeGreaterThanOrEqual(0);
      expect(res.body.compositeScore).toBeLessThanOrEqual(100);
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(res.body.band);

      // All five components present (ZM-RSK-004).
      for (const key of [
        'supplierVerification', 'dataConfidence', 'buyerProfile',
        'invoiceScore', 'platformBehavior',
      ]) {
        expect(res.body.components).toHaveProperty(key);
      }

      expect(typeof res.body.dataAvailabilityPct).toBe('number');
      expect(res.body.modelVersion).toBeTruthy();
      expect(res.body.disclaimer).toContain('decision support only');
    }, 60_000);

    it('used the trained model and says so', async () => {
      // The ML service is a precondition of this suite, so a rules-only
      // score here means the model genuinely failed rather than being absent.
      const res = await api('supplier', 'get', `/transactions/${txId}/risk`);
      // toMatchObject rather than a bare toBe so a failure prints the whole
      // payload — "expected true, received undefined" says nothing about why.
      expect(res.body).toMatchObject({ mlUsed: true });
      expect('mlFallbackReason' in res.body).toBe(false);
    });

    it('records the synthetic-training-data limitation (ZM-RSK-016)', async () => {
      const res = await api('supplier', 'get', `/transactions/${txId}/risk`);
      expect(res.body.reasonCodes).toContain('INFO_SYNTHETIC_TRAINING_DATA');
    });

    it('is stable across reads — a score is stored, not recomputed per request', async () => {
      // ZM-RSK-010 in its everyday form: two reads of the same transaction
      // must not disagree, or nothing downstream can cite a score.
      const first = await api('supplier', 'get', `/transactions/${txId}/risk`);
      const second = await api('supplier', 'get', `/transactions/${txId}/risk`);
      expect(second.body.compositeScore).toBe(first.body.compositeScore);
      expect(second.body.calculatedAt).toBe(first.body.calculatedAt);
    });

    it('DRILL 1 — with the model service unreachable, falls back to rules and flags it', async () => {
      // The phase file's first checkpoint drill. The client is pointed at a
      // closed port, which exercises the real fetch-failure path rather than
      // a stubbed rejection: connection refused, the client's catch, the
      // degraded shape, persistence, and the response field.
      const config = app.get(AppConfig) as { ml: { url: string } };
      const original = config.ml.url;
      config.ml.url = 'http://127.0.0.1:9';

      try {
        const assessment = await app.get(RiskService).calculate(txId);

        expect(assessment.ml_used).toBe(false);
        // Visibly flagged, not silently degraded (ZM-RSK-017).
        expect(assessment.ml_fallback_reason).toBeTruthy();
        // Still a real score: the rules carry it on their own.
        expect(assessment.composite_score).toBeGreaterThan(0);
        expect(assessment.band).toBeTruthy();
      } finally {
        config.ml.url = original;
      }
    }, 60_000);

    it('DRILL 2 — an unavailable government source lowers availability, not the score', async () => {
      // The phase file's ZM-RSK-005 drill, run over the REAL facts gathered
      // from the hosted database for the transaction submitted above.
      //
      // The pair is built in memory rather than by deleting the seed's
      // government rows. That is not squeamishness: a test that mutates
      // shared registry data and then fails mid-way leaves the database in a
      // state the next suite silently scores against. The facts are real; the
      // outage is simulated at the one place it enters the system.
      const risk = app.get(RiskService);
      const live = await risk.gatherFacts(txId);

      const blinded: typeof live = {
        ...live,
        supplier: {
          ...live.supplier,
          registryStatus: unavailable('SOURCE_UNAVAILABLE'),
          bankAccountVerified: unavailable('SOURCE_UNAVAILABLE'),
          signatoryMatches: unavailable('SOURCE_UNAVAILABLE'),
          taxStatusValid: unavailable('SOURCE_UNAVAILABLE'),
          provenance: [],
        },
        buyer: {
          registryStatus: unavailable('SOURCE_UNAVAILABLE'),
          companyAgeYears: unavailable('SOURCE_UNAVAILABLE'),
          priorTransactionsWithSupplier: unavailable('SOURCE_UNAVAILABLE'),
          onTimePaymentRatio: unavailable('SOURCE_UNAVAILABLE'),
        },
      };

      const before = allComponents(live);
      const after = allComponents(blinded);

      // The invariant, stated exactly: no component may fall. Components
      // whose every signal went dark score null rather than zero, which is
      // also not a fall — it is an absence, and availability carries it.
      for (const component of before) {
        const blindedComponent = after.find((c) => c.key === component.key)!;
        if (component.score === null || blindedComponent.score === null) continue;
        expect(blindedComponent.score).toBeGreaterThanOrEqual(component.score);
      }

      // And the separate measure does move.
      expect(dataAvailabilityPct(after)).toBeLessThan(dataAvailabilityPct(before));
    }, 60_000);

    it('gives another supplier 404 for the score, exactly as for the transaction', async () => {
      const res = await api('petra', 'get', `/transactions/${txId}/risk`);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------
  // duplicates
  // -------------------------------------------------------------------

  describe('duplicate invoices (ZM-VER-001)', () => {
    /** Drives a second transaction to the point of submit. */
    const submitInvoice = async (
      invoiceNumber: string,
      overrides: Record<string, string> = {},
      persona = 'supplier',
      linkBuyerId = buyerId,
    ) => {
      const draft = await api(persona, 'post', '/transactions');
      const id = draft.body.id;
      created.push(id);

      await api(persona, 'put', `/transactions/${id}/invoice`, {
        invoiceNumber,
        einvoiceIdentifier: 'JO-EINV-20000101-0001',
        issueDate: '2026-05-10',
        dueDate: '2026-08-10',
        subtotalAmount: '10650.000',
        taxAmount: '1704.000',
        faceValue: '12354.000',
        paidAmount: '0.000',
        ...overrides,
      });
      await api(persona, 'put', `/transactions/${id}/buyer`, { buyerId: linkBuyerId });
      await api(persona, 'post', `/transactions/${id}/declarations`, {
        declarationTemplateVersion: '1.0',
        isAuthentic: true,
        goodsDelivered: true,
        unpaidAndNotCancelled: true,
        noKnownDispute: true,
        notPreviouslyFinanced: true,
        buyerIsNamedEntity: true,
        contactIsBuyerRep: true,
        acceptsRecourse: true,
      });
      return api(persona, 'post', `/transactions/${id}/submit`);
    };

    it('blocks a duplicate with 409, opens a review, and names no counterparty', async () => {
      const res = await submitInvoice('INV-2026-0001');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_INVOICE');
      expect(res.body.details.reviewReference).toBeTruthy();
      // Telling this supplier which transaction it collided with would leak
      // the existence and identity of another party's financing.
      expect(JSON.stringify(res.body)).not.toContain(txId);
    }, 120_000);

    /**
     * The checkpoint scenario, and the case the v1 fingerprint could not
     * catch: a *different* supplier claiming the receivable Al-Noor already
     * submitted. This is one invoice financed twice — the most expensive
     * fraud the platform is exposed to — and until the fingerprint dropped
     * the submitting supplier from its key, it reached ELIGIBLE unblocked.
     *
     * Petra resolves the same buyer under its own relationship (which is
     * legitimate and must keep working) and then submits Al-Noor's invoice.
     */
    it('blocks a SECOND SUPPLIER claiming the same receivable (ZM-VER-001)', async () => {
      const resolve = await api('petra', 'post', '/buyers/resolve', {
        nationalEstablishmentNumber: '30000201',
        confirmedByUser: true,
        contact: {
          contactName: 'Rami Haddad',
          contactRole: 'Finance',
          contactPhone: '+962790000222',
        },
      });
      expect(resolve.status).toBe(200);

      const res = await submitInvoice('INV-2026-0001', {}, 'petra', resolve.body.id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_INVOICE');
      expect(res.body.details.reviewReference).toBeTruthy();
      // Al-Noor's identity must not leak to the second claimant: telling a
      // fraudster whose invoice they collided with confirms the receivable
      // is real and names the counterparty.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(txId);
      expect(serialized).not.toContain(orgs.supplier);
      expect(serialized).not.toContain('Al-Noor');
    }, 120_000);

    it('is not evaded by reformatting the invoice number', async () => {
      // Same invoice, retyped by hand. The fingerprint normalizes before
      // hashing precisely so this does not become a second financing.
      const res = await submitInvoice('inv 2026 0001');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_INVOICE');
    }, 120_000);

    it('holds a past-due invoice back from ELIGIBLE (AS-07)', async () => {
      const res = await submitInvoice('INV-2026-0004', {
        einvoiceIdentifier: 'JO-EINV-20000101-0004',
        issueDate: '2026-01-05',
        dueDate: '2026-03-05',
        subtotalAmount: '10000.000',
        taxAmount: '1600.000',
        faceValue: '11600.000',
      });
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('UNDER_REVIEW');
    }, 120_000);
  });
});
