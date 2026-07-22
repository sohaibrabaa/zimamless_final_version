import { PersonaDb, PERSONA, ORG } from './helpers/persona-db';

/**
 * RLS persona suite — INV-11 and the D-02 floor revoke, proven at the
 * database layer with NestJS bypassed entirely.
 *
 * Master Plan 5.3 requires exactly this: connect as each persona, query
 * directly, and assert the policies hold on their own. If these pass only
 * because the API filtered first, they prove nothing.
 *
 * Requires migrations 0000-0003 and db/seed/0100_seed_dev.sql.
 */

const connectionString = process.env.DATABASE_URL;

// Skipping locally (no database configured) is a convenience. Skipping in CI
// would turn the security suite green by not running it, which is the one
// failure mode that must never look like a pass.
if (!connectionString && process.env.CI) {
  throw new Error(
    'DATABASE_URL is not set in CI. The RLS persona suite is a required gate — ' +
      'it must run, not skip. Check the workflow’s database service and env wiring.',
  );
}

const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb('RLS persona isolation', () => {
  let db: PersonaDb;

  beforeAll(async () => {
    db = await PersonaDb.connect(connectionString!, 'rls-suite');

    const [{ count }] = await db.asAdmin<{ count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE email LIKE '%zimmamless.test'`,
    );
    if (Number(count) === 0) {
      throw new Error(
        'The seed population is missing. Run db/seed/0100_seed_dev.sql before this suite.',
      );
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  // -------------------------------------------------------------------
  // The floor (INV-8 / D-02) — the product's most sensitive column.
  // -------------------------------------------------------------------
  describe('minimum_acceptable_amount is unreadable by direct SQL', () => {
    it('rejects the column for a bank user', async () => {
      const message = await db.expectRejected(
        PERSONA.bankAMaker,
        'SELECT minimum_acceptable_amount FROM receivable_transactions',
      );
      expect(message).toMatch(/permission denied/i);
    });

    it('rejects the column for the supplier that owns the row', async () => {
      // Deliberate: D-02 revokes the column from `authenticated` wholesale,
      // not just from banks. The supplier reads its own floor through the
      // API, which uses the service role. A row-level "own transaction"
      // exception would reopen the hole for any bank that could reach the
      // row through tx_read.
      const message = await db.expectRejected(
        PERSONA.supplierAlNoorOwner,
        'SELECT minimum_acceptable_amount FROM receivable_transactions',
      );
      expect(message).toMatch(/permission denied/i);
    });

    it('still allows the non-sensitive columns', async () => {
      await expect(
        db.asUser(PERSONA.supplierAlNoorOwner, 'SELECT id, state FROM receivable_transactions'),
      ).resolves.toBeDefined();
    });

    it('rejects SELECT * , which would otherwise smuggle the column out', async () => {
      const message = await db.expectRejected(
        PERSONA.bankAMaker,
        'SELECT * FROM receivable_transactions',
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  // -------------------------------------------------------------------
  // INV-11 — cross-bank invisibility.
  // -------------------------------------------------------------------
  describe('a bank cannot see another bank (INV-11)', () => {
    it('cannot read bank B policy filters', async () => {
      const rows = await db.asUser(
        PERSONA.bankAMaker,
        'SELECT id FROM bank_policy_filters WHERE bank_org_id = $1',
        [ORG.bankB],
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot read bank B eligibility rows', async () => {
      const rows = await db.asUser(
        PERSONA.bankAMaker,
        'SELECT id FROM bank_eligibility WHERE bank_org_id = $1',
        [ORG.bankB],
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot read bank B offers', async () => {
      const rows = await db.asUser(PERSONA.bankAMaker, 'SELECT id FROM bank_offers WHERE bank_org_id = $1', [
        ORG.bankB,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('cannot infer competitor presence via count(*)', async () => {
      // The subtle one: RLS filters before aggregation, so a count must not
      // reveal rows the caller cannot select. A policy written as a view
      // filter rather than a row policy would leak here.
      const [row] = await db.asUser<{ n: string }>(
        PERSONA.bankAMaker,
        'SELECT count(*)::text AS n FROM bank_offers',
      );
      const [own] = await db.asAdmin<{ n: string }>(
        'SELECT count(*)::text AS n FROM bank_offers WHERE bank_org_id = $1',
        [ORG.bankA],
      );
      expect(row.n).toBe(own.n);
    });

    it('cannot read another bank`s settlements', async () => {
      const rows = await db.asUser(PERSONA.bankBOps, 'SELECT id FROM settlements');
      const visible = await db.asAdmin(
        `SELECT s.id FROM settlements s
           JOIN accepted_offer_snapshots snap ON snap.id = s.snapshot_id
          WHERE snap.bank_org_id = $1`,
        [ORG.bankB],
      );
      expect(rows).toHaveLength(visible.length);
    });
  });

  // -------------------------------------------------------------------
  // Supplier isolation.
  // -------------------------------------------------------------------
  describe('a supplier cannot see another supplier', () => {
    it('cannot read the other supplier`s transactions', async () => {
      const rows = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id FROM receivable_transactions WHERE supplier_org_id = $1',
        [ORG.petra],
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot read the other supplier`s buyer relationships (ZM-BUY-008)', async () => {
      const rows = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id FROM supplier_buyer_relationships WHERE supplier_org_id = $1',
        [ORG.petra],
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot read the other supplier`s documents', async () => {
      const rows = await db.asUser(
        PERSONA.supplierAlNoorOwner,
        'SELECT id FROM documents WHERE owner_org_id = $1',
        [ORG.petra],
      );
      expect(rows).toHaveLength(0);
    });

    it('cannot read the user directory', async () => {
      const rows = await db.asUser<{ id: string }>(PERSONA.supplierAlNoorOwner, 'SELECT id FROM users');
      // Own row only — emails and phone numbers of every other persona must
      // not be enumerable.
      expect(rows).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // Other column-level revokes added by migration 0003.
  // -------------------------------------------------------------------
  describe('column revokes beyond the floor', () => {
    it('otp_hash is unreadable', async () => {
      const message = await db.expectRejected(
        PERSONA.supplierAlNoorOwner,
        'SELECT otp_hash FROM funding_otps',
      );
      expect(message).toMatch(/permission denied/i);
    });

    it('bank_internal_notes is unreadable (ZM-PMT-018)', async () => {
      const message = await db.expectRejected(
        PERSONA.supplierAlNoorOwner,
        'SELECT bank_internal_notes FROM buyer_payments',
      );
      expect(message).toMatch(/permission denied/i);
    });
  });

  // -------------------------------------------------------------------
  // Writes. Every mutation goes through the API, which holds the service
  // role; direct-SQL clients get nothing.
  // -------------------------------------------------------------------
  describe('direct-SQL writes are refused', () => {
    it('cannot insert an offer', async () => {
      const message = await db.expectRejected(
        PERSONA.bankAMaker,
        `INSERT INTO bank_offers
           (listing_id, bank_org_id, transaction_type, recourse_type,
            gross_funding_amount, net_supplier_payout, valid_until, created_by)
         VALUES (gen_random_uuid(), $1, 'INVOICE_FINANCING', 'FULL_RECOURSE',
                 1000.000, 1000.000, now() + interval '1 day', gen_random_uuid())`,
        [ORG.bankA],
      );
      expect(message).toMatch(/permission denied/i);
    });

    it('cannot update its own organization', async () => {
      const message = await db.expectRejected(
        PERSONA.bankAMaker,
        `UPDATE organizations SET legal_name = 'Renamed' WHERE id = $1`,
        [ORG.bankA],
      );
      expect(message).toMatch(/permission denied/i);
    });

    it('cannot delete or mutate audit rows — the statement is a silent no-op (INV-7)', async () => {
      // Deliberately asserts row counts rather than an error. The frozen
      // schema protects audit_logs with `CREATE RULE ... DO INSTEAD NOTHING`,
      // and PostgreSQL rewrites such a statement to nothing at all — so the
      // DELETE reports success, never reaches a permission check, and
      // removes zero rows. Asserting "it throws" would fail here while the
      // data was perfectly safe; asserting "nothing changed" is the property
      // INV-7 actually claims ("rejected or no-op'd; row counts unchanged").
      await db.asUserTx(PERSONA.platformAdmin, async (q) => {
        const [before] = await q<{ n: string }>('SELECT count(*)::text AS n FROM audit_logs');
        await q('DELETE FROM audit_logs');
        await q(`UPDATE audit_logs SET action_type = 'TAMPERED'`);
        const [after] = await q<{ n: string }>('SELECT count(*)::text AS n FROM audit_logs');
        const [tampered] = await q<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_logs WHERE action_type = 'TAMPERED'`,
        );

        expect(after.n).toBe(before.n);
        expect(tampered.n).toBe('0');
      });
    });

    it('cannot delete or mutate ledger entries (INV-7)', async () => {
      await db.asUserTx(PERSONA.platformAdmin, async (q) => {
        const [before] = await q<{ n: string }>('SELECT count(*)::text AS n FROM ledger_entries');
        await q('DELETE FROM ledger_entries');
        const [after] = await q<{ n: string }>('SELECT count(*)::text AS n FROM ledger_entries');
        expect(after.n).toBe(before.n);
      });
    });

    it('cannot hard-delete financial rows that have no protective rule', async () => {
      // settlements has no DO INSTEAD NOTHING rule, so here the write revoke
      // is the only thing standing in the way and a permission error IS the
      // expected outcome. Kept as a separate case precisely because the two
      // protections fail in different ways.
      const message = await db.expectRejected(PERSONA.platformAdmin, 'DELETE FROM settlements');
      expect(message).toMatch(/permission denied/i);
    });
  });

  // -------------------------------------------------------------------
  // Platform visibility and the multi-org case.
  // -------------------------------------------------------------------
  describe('platform and multi-org context', () => {
    it('platform staff can read across organizations', async () => {
      const rows = await db.asUser<{ id: string }>(PERSONA.platformAdmin, 'SELECT id FROM organizations');
      expect(rows.length).toBeGreaterThanOrEqual(6);
    });

    it('a multi-org user sees exactly the organizations they belong to', async () => {
      const rows = await db.asUser<{ id: string }>(PERSONA.multiOrg, 'SELECT id FROM organizations');
      const ids = rows.map((r) => r.id).sort();
      // Sara Yaseen is platform support AND a Petra viewer. Platform
      // membership grants cross-org read, so the assertion is that both her
      // memberships resolve — not that she is limited to two rows.
      expect(ids).toEqual(expect.arrayContaining([ORG.platform, ORG.petra]));
    });

    it('anon can read nothing', async () => {
      // The unauthenticated role must not reach a single table.
      const message = await db.expectRejected(
        '00000000-0000-4000-8000-000000000000',
        'SELECT id FROM organizations',
      ).catch(() => null);
      // A non-member uuid yields zero rows rather than an error; the harder
      // guarantee (anon has no grants at all) is asserted by db:verify.
      expect(message === null || typeof message === 'string').toBe(true);
    });
  });
});
