import { PersonaDb, PERSONA, ORG } from './helpers/persona-db';

/**
 * RLS persona suite, Phase 2 and Phase 3 tables — **with rows in them**.
 *
 * This closes the carry-over recorded in `PHASE_2_AGENT_A.md` §6 and named
 * again in the Phase 3 kickoff. The Phase 1 and Phase 2 suites asserted that
 * a supplier sees zero of another supplier's rows in these tables, which was
 * true and proved nothing: the tables were empty, so every query returned
 * zero rows for everyone. A policy that has never been asked about a real
 * row has not been tested.
 *
 * So every describe block below begins by asserting, as admin, that the rows
 * it is about actually exist. If the fixtures are missing the suite FAILS
 * rather than passing vacuously — which is the same reasoning that made the
 * Phase 1 audit turn the absent-DATABASE_URL skip into a throw.
 *
 * Requires migrations 0000-0005 and `db/seed/0100_seed_dev.sql`. Everything
 * else it needs, it arranges and removes itself — see FIX below. It used to
 * require "at least one submitted transaction, which the live verification
 * run creates", which meant the suite's result depended on what someone had
 * run by hand beforehand.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. The RLS persona suite is a required gate — ' +
      'it must run, not skip.',
  );
}

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('RLS with rows present (Phase 2 + Phase 3 carry-over)', () => {
  let db: PersonaDb;

  /** Fails the suite rather than letting an empty table pass as isolation. */
  const requireRows = async (table: string, where = '', params: unknown[] = []): Promise<number> => {
    const [row] = await db.asAdmin<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table} ${where}`,
      params,
    );
    const n = Number(row.n);
    if (n === 0) {
      throw new Error(
        `${table} ${where} has no rows. This suite exists to test policies against REAL rows; ` +
          'an empty table would make every assertion below vacuously true. Run the Phase 3 ' +
          'live verification (or the seed) before this suite.',
      );
    }
    return n;
  };

  /**
   * Fixture ids, fixed so teardown is exact and a re-run cannot accumulate.
   *
   * These rows are arranged here rather than inherited from a live run. The
   * suite used to depend on residue left behind by the Phase 3 verification
   * script, which is the same mistake the Phase 2 audit recorded in the other
   * direction — residue described as fixtures. It also made the suite pass or
   * fail depending on what someone had run that afternoon.
   *
   * Writing these rows by hand is honest for THIS suite in a way it would not
   * be for the seed. An RLS policy is evaluated on ownership columns; it
   * neither knows nor cares whether the fingerprint was genuinely computed.
   * The claim under test is "a Petra token cannot see an Al-Noor row", and
   * these rows are real Al-Noor rows. The seed refuses to invent invoices for
   * the opposite reason: there the claim under test would have been about the
   * duplicate check, which an invented fingerprint would fake.
   */
  const FIX = {
    tx: '0e400000-0000-4000-8000-000000000001',
    invoice: '0e400000-0000-4000-8000-000000000002',
    document: '0e400000-0000-4000-8000-000000000003',
    extraction: '0e400000-0000-4000-8000-000000000004',
    run: '0e400000-0000-4000-8000-000000000005',
    check: '0e400000-0000-4000-8000-000000000006',
    fraudCase: '0e400000-0000-4000-8000-000000000007',
    indicator: '0e400000-0000-4000-8000-000000000008',
    attempt: '0e400000-0000-4000-8000-000000000009',
  } as const;

  const AL_NOOR_OWNER_USER = '0e100000-0000-4000-8000-000000000001';

  /** Child-first, so a re-run starts from a clean slate either way. */
  const dropFixtures = async (): Promise<void> => {
    await db.asAdmin('DELETE FROM buyer_resolution_attempts WHERE id = $1', [FIX.attempt]);
    await db.asAdmin('DELETE FROM fraud_indicators WHERE id = $1', [FIX.indicator]);
    await db.asAdmin('DELETE FROM fraud_cases WHERE id = $1', [FIX.fraudCase]);
    await db.asAdmin('DELETE FROM verification_checks WHERE id = $1', [FIX.check]);
    await db.asAdmin('DELETE FROM verification_runs WHERE id = $1', [FIX.run]);
    await db.asAdmin('DELETE FROM document_extractions WHERE id = $1', [FIX.extraction]);
    await db.asAdmin('DELETE FROM documents WHERE id = $1', [FIX.document]);
    await db.asAdmin('DELETE FROM invoices WHERE id = $1', [FIX.invoice]);
    await db.asAdmin('DELETE FROM receivable_transactions WHERE id = $1', [FIX.tx]);
  };

  beforeAll(async () => {
    db = await PersonaDb.connect(connectionString!, 'rls-phase3');
    await dropFixtures();

    await db.asAdmin(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, state, minimum_acceptable_amount, created_by)
       VALUES ($1, 'ZM-RLS-FIXTURE-1', $2, 'ELIGIBLE', 900.000, $3)`,
      [FIX.tx, ORG.alNoor, AL_NOOR_OWNER_USER],
    );

    await db.asAdmin(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1, $2, 'RLS-FIXTURE-1', 'JO-EINV-RLSFIXTURE-0001', DATE '2026-01-01',
               DATE '2026-06-01', 1000.000, 0, 1000.000, 0, 1000.000, 'rls-fixture-v1')`,
      [FIX.invoice, FIX.tx],
    );

    await db.asAdmin(
      `INSERT INTO documents
         (id, owner_org_id, document_type, storage_path, file_name, mime_type, size_bytes,
          file_hash, subject_type, subject_id, uploaded_by)
       VALUES ($1, $2, 'ELECTRONIC_INVOICE', 'rls-fixture/invoice.pdf', 'invoice.pdf',
               'application/pdf', 1024, 'rls-fixture-hash', 'TRANSACTION', $3, $4)`,
      [FIX.document, ORG.alNoor, FIX.tx, AL_NOOR_OWNER_USER],
    );

    await db.asAdmin(
      `INSERT INTO document_extractions
         (id, document_id, extraction_kind, raw_output, extracted_fields, confidence, succeeded)
       VALUES ($1, $2, 'OCR', '{"lines":[]}'::jsonb, '{}'::jsonb, 0.9, true)`,
      [FIX.extraction, FIX.document],
    );

    await db.asAdmin(
      `INSERT INTO verification_runs (id, transaction_id, completed_at, overall_result)
       VALUES ($1, $2, now(), 'PASS')`,
      [FIX.run, FIX.tx],
    );

    await db.asAdmin(
      `INSERT INTO verification_checks (id, run_id, check_type, result)
       VALUES ($1, $2, 'COMPLETENESS', 'PASS')`,
      [FIX.check, FIX.run],
    );

    await db.asAdmin(
      `INSERT INTO fraud_cases (id, transaction_id, organization_id, status, summary, opened_by)
       VALUES ($1, $2, $3, 'OPEN', 'RLS fixture — duplicate invoice referral', $4)`,
      [FIX.fraudCase, FIX.tx, ORG.alNoor, AL_NOOR_OWNER_USER],
    );

    await db.asAdmin(
      `INSERT INTO fraud_indicators (id, fraud_case_id, indicator_type, source_reference)
       VALUES ($1, $2, 'DUPLICATE_INVOICE', 'rls-fixture-v1')`,
      [FIX.indicator, FIX.fraudCase],
    );

    // A search this supplier ran. Buyer search history is competitively
    // sensitive on its own — who a supplier is looking up says who they are
    // about to invoice — so it gets the same treatment as the invoice.
    await db.asAdmin(
      `INSERT INTO buyer_resolution_attempts (id, supplier_org_id, search_term, status, selected_by)
       VALUES ($1, $2, '30000201', 'MATCHED', $3)`,
      [FIX.attempt, ORG.alNoor, AL_NOOR_OWNER_USER],
    );
  });

  afterAll(async () => {
    if (db) {
      await dropFixtures().catch(() => undefined);
      await db.close();
    }
  });

  // -------------------------------------------------------------------
  // Phase 2 tables — the carry-over PHASE_2_AGENT_A.md §6 recorded.
  // -------------------------------------------------------------------
  describe('supplier_applications', () => {
    it('has rows for both suppliers (otherwise this suite proves nothing)', async () => {
      await requireRows('supplier_applications');
      await requireRows('supplier_applications', 'WHERE organization_id = $1', [ORG.alNoor]);
    });

    it('a supplier sees its own application', async () => {
      const rows = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id FROM supplier_applications WHERE organization_id = $1',
        [ORG.alNoor],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('a supplier sees NONE of another supplier`s applications', async () => {
      const visible = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id FROM supplier_applications WHERE organization_id = $1',
        [ORG.petra],
      );
      const actual = await db.asAdmin(
        'SELECT id FROM supplier_applications WHERE organization_id = $1',
        [ORG.petra],
      );
      // The assertion that matters: rows genuinely exist, and are invisible.
      expect(actual.length).toBeGreaterThan(0);
      expect(visible).toHaveLength(0);
    });

    it('a bank sees no supplier applications at all', async () => {
      const rows = await db.asUser(PERSONA.bankAMaker, 'SELECT id FROM supplier_applications');
      expect(rows).toHaveLength(0);
    });

    it('platform staff see every application', async () => {
      const total = await requireRows('supplier_applications');
      const rows = await db.asUser(PERSONA.platformAdmin, 'SELECT id FROM supplier_applications');
      expect(rows).toHaveLength(total);
    });
  });

  describe('sla_clock_events', () => {
    it('has rows', async () => {
      await requireRows('sla_clock_events');
    });

    it('a bank cannot read another organization`s SLA history', async () => {
      const rows = await db.asUser(PERSONA.bankAMaker, 'SELECT id FROM sla_clock_events');
      expect(rows).toHaveLength(0);
    });

    it('a supplier sees only events for its own application', async () => {
      const visible = await db.asUser<{ application_id: string }>(
        PERSONA.supplierAlNoorOwner,
        'SELECT application_id FROM sla_clock_events',
      );
      const own = await db.asAdmin<{ id: string }>(
        'SELECT id FROM supplier_applications WHERE organization_id = $1',
        [ORG.alNoor],
      );
      const ownIds = new Set(own.map((r) => r.id));
      for (const row of visible) expect(ownIds.has(row.application_id)).toBe(true);
    });
  });

  describe('entity_field_values (government provenance)', () => {
    it('has rows', async () => {
      await requireRows('entity_field_values');
    });

    it('a supplier cannot read another organization`s government field values', async () => {
      // Read in this direction deliberately: Al-Noor is the organization
      // that has been through government verification, so it is the one
      // with rows. Asking whether Al-Noor can see Petra's would have passed
      // for the wrong reason — Petra has none to see.
      const actual = await db.asAdmin(
        `SELECT id FROM entity_field_values WHERE entity_type = 'ORGANIZATION' AND entity_id = $1`,
        [ORG.alNoor],
      );
      expect(actual.length).toBeGreaterThan(0);

      const visible = await db.asUser(
        PERSONA.supplierPetraOwner,
        `SELECT id FROM entity_field_values WHERE entity_type = 'ORGANIZATION' AND entity_id = $1`,
        [ORG.alNoor],
      );
      expect(visible).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------
  // Phase 3 tables.
  // -------------------------------------------------------------------
  describe('receivable_transactions and invoices', () => {
    it('has a submitted transaction with an invoice', async () => {
      await requireRows('receivable_transactions', 'WHERE supplier_org_id = $1', [ORG.alNoor]);
      await requireRows('invoices');
    });

    it('a supplier sees its own transactions', async () => {
      const rows = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id, state FROM receivable_transactions',
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('another supplier sees none of them', async () => {
      const rows = await db.asUser(
        PERSONA.supplierPetraOwner,
        'SELECT id FROM receivable_transactions WHERE supplier_org_id = $1',
        [ORG.alNoor],
      );
      expect(rows).toHaveLength(0);
    });

    it('a bank sees no transaction that has never been listed', async () => {
      // This used to assert a bank sees ZERO transactions, on the reasoning
      // that Phase 3 created no listings at all. Phase 5 made that premise
      // false: a bank legitimately sees listings it was found eligible for,
      // which is the marketplace working. The claim the test was always
      // about is narrower and still holds — an UNLISTED transaction is
      // invisible — so it is now asserted directly against this suite's own
      // fixture, which is never listed.
      const rows = await db.asUser<{ id: string }>(
        PERSONA.bankAMaker,
        'SELECT id FROM receivable_transactions WHERE id = $1',
        [FIX.tx],
      );
      expect(rows).toHaveLength(0);
    });

    it('the supplier floor stays unreadable even now that rows carry one', async () => {
      // D-02 with real data behind it: previously this column was revoked on
      // an empty table, which a broken grant would also have passed.
      await requireRows('receivable_transactions', 'WHERE minimum_acceptable_amount IS NOT NULL');
      const message = await db.expectRejected(
        PERSONA.supplierAlNoorOwner,
        'SELECT minimum_acceptable_amount FROM receivable_transactions',
      );
      expect(message).toMatch(/permission denied/i);
    });

    it('a supplier cannot read another supplier`s invoices', async () => {
      const visible = await db.asUser<{ id: string }>(PERSONA.supplierPetraOwner, 'SELECT id FROM invoices');
      const alNoorInvoices = await db.asAdmin(
        `SELECT i.id FROM invoices i
           JOIN receivable_transactions t ON t.id = i.transaction_id
          WHERE t.supplier_org_id = $1`,
        [ORG.alNoor],
      );
      expect(alNoorInvoices.length).toBeGreaterThan(0);
      const visibleIds = new Set(visible.map((r) => r.id));
      for (const row of alNoorInvoices as { id: string }[]) {
        expect(visibleIds.has(row.id)).toBe(false);
      }
    });
  });

  describe('documents and document_extractions', () => {
    it('has an uploaded document with extractions', async () => {
      await requireRows('documents', 'WHERE owner_org_id = $1', [ORG.alNoor]);
      await requireRows('document_extractions');
    });

    it('the owning supplier sees its documents', async () => {
      const rows = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id FROM documents WHERE owner_org_id = $1',
        [ORG.alNoor],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('a bank cannot read the supplier`s documents (ZM-DOC-004 at the RLS layer)', async () => {
      // The API refuses this too — the drill in the live checkpoint proves
      // that half. This is the independent backup: even a direct-SQL client
      // holding a bank JWT gets nothing.
      const rows = await db.asUser(PERSONA.bankAMaker, 'SELECT id FROM documents');
      expect(rows).toHaveLength(0);
    });

    it('another supplier cannot read them either', async () => {
      const rows = await db.asUser(
        PERSONA.supplierPetraOwner,
        'SELECT id FROM documents WHERE owner_org_id = $1',
        [ORG.alNoor],
      );
      expect(rows).toHaveLength(0);
    });

    it('extraction rows follow their document', async () => {
      const rows = await db.asUser(PERSONA.bankAMaker, 'SELECT id FROM document_extractions');
      expect(rows).toHaveLength(0);
    });
  });

  describe('verification runs and checks', () => {
    it('has a completed run', async () => {
      await requireRows('verification_runs');
      await requireRows('verification_checks');
    });

    it('a supplier sees its own verification results', async () => {
      const rows = await db.asUser(PERSONA.supplierAlNoorOwner, 'SELECT id FROM verification_runs');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('another supplier sees none of them', async () => {
      const rows = await db.asUser(PERSONA.supplierPetraOwner, 'SELECT id FROM verification_runs');
      expect(rows).toHaveLength(0);
    });

    it('individual checks are not readable around the run policy', async () => {
      const rows = await db.asUser(PERSONA.supplierPetraOwner, 'SELECT id FROM verification_checks');
      expect(rows).toHaveLength(0);
    });
  });

  describe('buyers and relationships (ZM-BUY-008)', () => {
    it('has a resolved buyer and a relationship', async () => {
      await requireRows('buyers');
      await requireRows('supplier_buyer_relationships', 'WHERE supplier_org_id = $1', [ORG.alNoor]);
    });

    it('a supplier sees its own buyer relationships', async () => {
      const rows = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id FROM supplier_buyer_relationships WHERE supplier_org_id = $1',
        [ORG.alNoor],
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('another supplier cannot read them — contact data is relationship-scoped', async () => {
      const rows = await db.asUser(
        PERSONA.supplierPetraOwner,
        'SELECT id FROM supplier_buyer_relationships WHERE supplier_org_id = $1',
        [ORG.alNoor],
      );
      expect(rows).toHaveLength(0);
    });

    it('a supplier cannot read another supplier`s buyer search history', async () => {
      const actual = await db.asAdmin(
        'SELECT id FROM buyer_resolution_attempts WHERE supplier_org_id = $1',
        [ORG.alNoor],
      );
      expect(actual.length).toBeGreaterThan(0);
      const rows = await db.asUser(
        PERSONA.supplierPetraOwner,
        'SELECT id FROM buyer_resolution_attempts WHERE supplier_org_id = $1',
        [ORG.alNoor],
      );
      expect(rows).toHaveLength(0);
    });

    it('the encrypted buyer phone is not readable as plaintext', async () => {
      // contact_phone_enc is bytea under pgp_sym_encrypt; only the last four
      // digits are stored in the clear. A supplier reading their OWN row
      // still gets ciphertext, not the number.
      const rows = await db.asUser<{ contact_phone_enc: Buffer | null; contact_phone_last4: string | null }>(
        PERSONA.supplierAlNoorOwner,
        `SELECT contact_phone_enc, contact_phone_last4
           FROM supplier_buyer_relationships WHERE supplier_org_id = $1 LIMIT 1`,
        [ORG.alNoor],
      );
      expect(rows.length).toBeGreaterThan(0);
      if (rows[0].contact_phone_enc) {
        expect(rows[0].contact_phone_enc.toString('utf8')).not.toContain('962790000111');
      }
    });
  });

  describe('fraud cases opened by duplicate detection', () => {
    it('has a case from the blocked duplicate', async () => {
      await requireRows('fraud_cases');
      await requireRows('fraud_indicators');
    });

    it('a bank cannot read another organization`s fraud cases', async () => {
      const rows = await db.asUser(PERSONA.bankAMaker, 'SELECT id FROM fraud_cases');
      expect(rows).toHaveLength(0);
    });

    it('another supplier cannot read them', async () => {
      const rows = await db.asUser(PERSONA.supplierPetraOwner, 'SELECT id FROM fraud_cases');
      expect(rows).toHaveLength(0);
    });
  });
});
