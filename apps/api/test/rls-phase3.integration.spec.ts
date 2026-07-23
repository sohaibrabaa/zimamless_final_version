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
 * Requires migrations 0000-0005, `db/seed/0100_seed_dev.sql`, and at least
 * one submitted transaction for Al-Noor (the live verification run creates
 * one; `npm run db:seed` does not).
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

  beforeAll(async () => {
    db = await PersonaDb.connect(connectionString!, 'rls-phase3');
  });

  afterAll(async () => {
    await db?.close();
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
      // Phase 3 creates no listings, so a bank has been given sight of
      // nothing — and the policy, not the API, is what enforces that here.
      const rows = await db.asUser(PERSONA.bankAMaker, 'SELECT id FROM receivable_transactions');
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
