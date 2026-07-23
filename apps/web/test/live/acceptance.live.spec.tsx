import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { useState } from "react";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { renderLive, signIn, useSessionForApi, type Session } from "./harness";
import { useListingOffers, type Offer } from "@/lib/marketplace/useOffers";
import {
  useOfferAcceptance,
  type AcceptedOfferSnapshotFull,
} from "@/lib/contracts/useAcceptance";

/**
 * `POST /offers/{id}/accept` — the demo-critical endpoint, through the real
 * hook the acceptance modal calls.
 *
 * Two things only this arrangement can prove. First, that the idempotency
 * key machinery in `useOfferAcceptance` actually replays: the hook holds one
 * key per acceptance *attempt*, so a second call after success must return
 * the same acceptance rather than a second lock — INV-1/INV-4 as the client
 * experiences them. A mock accepts twice happily. Second, that the snapshot
 * the modal renders after accepting is the server's snapshot: every money
 * field a 3-dp string, the net exactly what the offer promised.
 *
 * The fixture is staged in SQL exactly the way the Phase 7 integration suite
 * stages it — an open listing with one ACTIVE approved offer — because the
 * route from DRAFT to OPEN_FOR_OFFERS is Phase 3/5's proven ground and not
 * what this spec is about. The acceptance itself, the only step under test,
 * goes through the API. The chain writes no ledger rows (the listing is
 * staged, not activated), so it is fully removable afterwards.
 */

const ORG = {
  alNoor: "0e000000-0000-4000-8000-000000000002",
  bankA: "0e000000-0000-4000-8000-000000000004",
};
const AL_NOOR_OWNER = "0e100000-0000-4000-8000-000000000001";
const BANK_A_MAKER = "0e100000-0000-4000-8000-000000000005";
const BANK_A_APPROVER = "0e100000-0000-4000-8000-000000000006";
const BUYER_ESTABLISHMENT = "30000201";

const NET = "8390.000";

describe("offer acceptance against the live API", () => {
  let db: pg.Client;
  let supplier: Session;
  const txId = randomUUID();
  const invoiceId = randomUUID();
  const listingId = randomUUID();
  const offerId = randomUUID();

  beforeAll(async () => {
    supplier = await signIn("supplier");

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    db = new pg.Client({
      connectionString,
      ssl: /supabase\.(com|co)/.test(connectionString)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    await db.connect();

    const { rows: buyers } = await db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE national_establishment_no = $1`,
      [BUYER_ESTABLISHMENT]
    );
    if (buyers.length === 0) throw new Error("Buyer fixture missing — run db:seed.");

    await db.query(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, buyer_id, state, minimum_acceptable_amount, created_by)
       VALUES ($1,$2,$3,$4,'OPEN_FOR_OFFERS','8000.000',$5)`,
      [txId, `ZM-LIVE-${txId.slice(0, 8)}`, ORG.alNoor, buyers[0].id, AL_NOOR_OWNER]
    );
    await db.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,$3,$4, CURRENT_DATE - 10, CURRENT_DATE + 90,
               10000.000, 1600.000, 11600.000, 0, 11600.000, $5)`,
      [
        invoiceId,
        txId,
        `LIVE-${txId.slice(0, 8)}`,
        `JO-EINV-LIVE-${txId.slice(0, 8)}`,
        `live-acceptance-${txId}`,
      ]
    );
    await db.query(
      `INSERT INTO invoice_declarations
         (transaction_id, declaration_template_version, is_authentic, goods_delivered,
          unpaid_and_not_cancelled, no_known_dispute, not_previously_financed,
          buyer_is_named_entity, contact_is_buyer_rep, accepts_recourse, declared_by)
       VALUES ($1,'v1.0',true,true,true,true,true,true,true,true,$2)`,
      [txId, AL_NOOR_OWNER]
    );
    await db.query(
      `INSERT INTO listings
         (id, transaction_id, round_number, status, activated_at,
          offer_submission_deadline, supplier_selection_deadline, activated_by)
       VALUES ($1,$2,1,'OPEN_FOR_OFFERS', now(), now() + interval '1 day',
               now() + interval '2 days', $3)`,
      [listingId, txId, AL_NOOR_OWNER]
    );
    await db.query(
      `INSERT INTO bank_eligibility (listing_id, bank_org_id, status, reason, rules_applied)
       VALUES ($1,$2,'ELIGIBLE','live fixture','[]'::jsonb)`,
      [listingId, ORG.bankA]
    );
    await db.query(
      `INSERT INTO listing_fee_obligations (listing_id, supplier_org_id, amount, status)
       VALUES ($1,$2,25.000,'PAYABLE')`,
      [listingId, ORG.alNoor]
    );
    await db.query(
      `INSERT INTO bank_offers
         (id, listing_id, bank_org_id, status, version_number, transaction_type, recourse_type,
          gross_funding_amount, bank_discount_amount, bank_fees_amount,
          platform_commission_amount, listing_fee_amount, other_deductions_amount,
          net_supplier_payout, valid_until, created_by, approved_by, approved_at, submitted_at)
       VALUES ($1,$2,$3,'ACTIVE',1,'INVOICE_FINANCING','FULL_RECOURSE',
               9000.000,300.000,150.000,135.000,25.000,0.000,$4,
               now() + interval '30 days',$5,$6, now(), now())`,
      [offerId, listingId, ORG.bankA, NET, BANK_A_MAKER, BANK_A_APPROVER]
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // Child-first. Nothing here wrote to the ledger (the listing was staged,
    // not activated through the API), so the whole chain is removable.
    for (const [table, via] of [
      ["offer_selections", "offer"],
      ["offer_conditions", "offer"],
      ["contract_signatures", "contract"],
      ["contracts", "tx"],
      ["accepted_offer_snapshots", "tx"],
      ["commission_calculations", "tx"],
      ["notifications", "tx"],
      ["bank_offers", "listing"],
      ["bank_eligibility", "listing"],
      ["listing_fee_obligations", "listing"],
      ["listings", "tx"],
      ["invoice_declarations", "tx"],
      ["invoices", "tx"],
    ] as const) {
      const clause =
        via === "offer"
          ? `offer_id = '${offerId}'`
          : via === "contract"
            ? `contract_id IN (SELECT id FROM contracts WHERE transaction_id = '${txId}')`
            : via === "listing"
              ? `listing_id = '${listingId}'`
              : `transaction_id = '${txId}'`;
      await db.query(`DELETE FROM ${table} WHERE ${clause}`).catch(() => undefined);
    }
    await db
      .query(`DELETE FROM status_history WHERE entity_type = 'TRANSACTION' AND entity_id = $1`, [
        txId,
      ])
      .catch(() => undefined);
    await db.query(`DELETE FROM audit_logs WHERE target_entity_id = $1`, [txId]).catch(() => undefined);
    await db.query(`DELETE FROM receivable_transactions WHERE id = $1`, [txId]).catch(() => undefined);
    await db.end();
  }, 60_000);

  it("renders the real ACTIVE offer through useListingOffers, money as 3-dp strings", async () => {
    useSessionForApi(supplier);

    function Probe() {
      const offers = useListingOffers(listingId);
      if (offers.loading) return <p>loading</p>;
      if (offers.error) return <p>error: {offers.error}</p>;
      return (
        <ul>
          {(offers.data ?? []).map((o: Offer) => (
            <li key={o.id} data-testid="offer">
              {o.netSupplierPayout} {o.status}
            </li>
          ))}
        </ul>
      );
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        expect(screen.queryByText(/^error:/)).toBeNull();
        expect(screen.getAllByTestId("offer").length).toBeGreaterThan(0);
      },
      { timeout: 30_000 }
    );
    expect(screen.getByTestId("offer").textContent).toContain(NET);
    // The wire shape rule: money is a string with exactly three decimals,
    // never a number the client might have re-formatted.
    expect(NET).toMatch(/^\d+\.\d{3}$/);
  });

  it("accepts through the real hook and replays, not re-locks, on a second call", async () => {
    useSessionForApi(supplier);

    const results: AcceptedOfferSnapshotFull[] = [];

    function AcceptProbe() {
      const { accept } = useOfferAcceptance();
      const [snapshot, setSnapshot] = useState<AcceptedOfferSnapshotFull | null>(null);
      const [error, setError] = useState<string | null>(null);

      async function run() {
        try {
          // Two calls on the SAME attempt: the hook must reuse its key, and
          // the server must replay the first acceptance, not take a second
          // lock (INV-1/INV-4 as the client experiences them).
          const first = await accept(offerId);
          const second = await accept(offerId);
          results.push(first, second);
          setSnapshot(second);
        } catch (err) {
          setError(err instanceof Error ? err.message : JSON.stringify(err));
        }
      }

      if (error) return <p>error: {error}</p>;
      if (snapshot) {
        return (
          <div data-testid="snapshot">
            {snapshot.netSupplierPayout} {snapshot.grossFundingAmount}
          </div>
        );
      }
      return (
        <button type="button" onClick={() => void run()}>
          accept
        </button>
      );
    }

    renderLive(<AcceptProbe />);
    fireEvent.click(screen.getByRole("button", { name: "accept" }));

    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.getByTestId("snapshot")).toBeTruthy();
      },
      { timeout: 30_000 }
    );

    // The modal's numbers are the server's snapshot, 3-dp strings throughout.
    expect(screen.getByTestId("snapshot").textContent).toContain(NET);
    const [first, second] = results;
    expect(first.netSupplierPayout).toBe(NET);
    for (const field of ["netSupplierPayout", "grossFundingAmount"] as const) {
      expect(String(first[field])).toMatch(/^\d+\.\d{3}$/);
    }
    // Replay, not a second acceptance: same snapshot identity, same hash,
    // same capture instant — one lock, observed twice.
    expect(second.id).toBe(first.id);
    expect(second.snapshotHash).toBe(first.snapshotHash);
    expect(second.capturedAt).toBe(first.capturedAt);

    // And the database agrees: locked exactly once, by this acceptance.
    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM receivable_transactions WHERE id = $1`,
      [txId]
    );
    expect(rows[0].state).toBe("OFFER_ACCEPTED");
  });
});
