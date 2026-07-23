import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";
import {
  activateListingForTransaction,
  useCurrentListing,
} from "@/lib/marketplace/useListingActivation";
import { useListing } from "@/lib/marketplace/useMarketplace";

/**
 * Listing activation and both sides of the listing read, live.
 *
 * Activation is the money moment ZM-FEE-002 hangs on: one POST creates the
 * listing, the fee obligation, the balanced ledger journal, per-bank
 * eligibility and the state change — atomically. The screen's half of that
 * is what this proves: the real hook activates a disposable ELIGIBLE
 * fixture, `useCurrentListing` renders the deadlines the server actually
 * set, and the bank's underwriting view (`useListing`) opens the same
 * listing with no floor anywhere in it.
 *
 * The chain is closed by a real supplier cancel afterwards, so the shared
 * marketplace feed is not left carrying one extra open listing per test
 * run. The ledger rows the activation wrote stay, as they must (INV-7);
 * the fee was incurred at activation regardless of what happened later —
 * ZM-FEE-002's exact wording, exercised by a test teardown.
 */

const ORG = { alNoor: "0e000000-0000-4000-8000-000000000002" };
const AL_NOOR_OWNER = "0e100000-0000-4000-8000-000000000001";
const BUYER_ESTABLISHMENT = "30000201";

describe("listing activation against the live API", () => {
  let db: pg.Client;
  let supplier: Session;
  let bankMaker: Session;
  const txId = randomUUID();
  let listingId: string | undefined;

  beforeAll(async () => {
    supplier = await signIn("supplier");
    bankMaker = await signIn("bankMaker");

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set.");
    db = new pg.Client({
      connectionString,
      ssl: /supabase\.(com|co)/.test(connectionString) ? { rejectUnauthorized: false } : undefined,
    });
    await db.connect();

    const { rows: buyers } = await db.query<{ id: string }>(
      `SELECT id FROM buyers WHERE national_establishment_no = $1`,
      [BUYER_ESTABLISHMENT]
    );
    await db.query(
      `INSERT INTO receivable_transactions
         (id, reference_number, supplier_org_id, buyer_id, state, minimum_acceptable_amount, created_by)
       VALUES ($1,$2,$3,$4,'ELIGIBLE','8000.000',$5)`,
      [txId, `ZM-LIVE-${txId.slice(0, 8)}`, ORG.alNoor, buyers[0].id, AL_NOOR_OWNER]
    );
    await db.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,$3,$4, CURRENT_DATE - 10, CURRENT_DATE + 90,
               10000.000, 1600.000, 11600.000, 0, 11600.000, $5)`,
      [randomUUID(), txId, `LIVE-L-${txId.slice(0, 8)}`, `JO-EINV-LIVE-L-${txId.slice(0, 8)}`, `live-listing-${txId}`]
    );
    await db.query(
      `INSERT INTO invoice_declarations
         (transaction_id, declaration_template_version, is_authentic, goods_delivered,
          unpaid_and_not_cancelled, no_known_dispute, not_previously_financed,
          buyer_is_named_entity, contact_is_buyer_rep, accepts_recourse, declared_by)
       VALUES ($1,'v1.0',true,true,true,true,true,true,true,true,$2)`,
      [txId, AL_NOOR_OWNER]
    );
  }, 60_000);

  afterAll(async () => {
    // Close the listing the real way: the supplier cancels, which closes
    // the listing and withdraws live offers with it (§16.8). The ledger
    // rows from activation stay — the fee was incurred at activation
    // regardless (ZM-FEE-002).
    await apiFetch(supplier, `/transactions/${txId}/cancel`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ reason: "Live screen test teardown." }),
    }).catch(() => undefined);
    await db?.end();
  }, 60_000);

  it("activates through the real hook and renders the server's deadlines", async () => {
    useSessionForApi(supplier);

    const listing = await activateListingForTransaction(txId);
    expect(listing?.id).toBeTruthy();
    expect(listing?.status).toBe("OPEN_FOR_OFFERS");
    listingId = listing?.id;

    function Probe() {
      const current = useCurrentListing(txId);
      if (current.loading) return <p>loading</p>;
      if (current.error) return <p>error: {current.error}</p>;
      if (!current.data) return <p>no listing</p>;
      return (
        <div data-testid="listing">
          {current.data.status} closes:{String(current.data.offerSubmissionDeadline)} select-by:
          {String(current.data.supplierSelectionDeadline)}
        </div>
      );
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.getByTestId("listing")).toBeTruthy();
      },
      { timeout: 30_000 }
    );

    const text = screen.getByTestId("listing").textContent ?? "";
    expect(text).toContain("OPEN_FOR_OFFERS");
    // The deadlines are the server's, real ISO instants — not something the
    // client computed from "now".
    expect(text).toMatch(/closes:\d{4}-\d{2}-\d{2}T/);
    expect(text).toMatch(/select-by:\d{4}-\d{2}-\d{2}T/);

    // The database backs the screen: the activation wrote its fee
    // obligation in the same act (ZM-FEE-002).
    const { rows: fees } = await db.query(
      `SELECT status FROM listing_fee_obligations WHERE listing_id = $1`,
      [listingId]
    );
    expect(fees.length).toBe(1);
  });

  it("opens the same listing in the bank's underwriting view, floor-free", async () => {
    useSessionForApi(bankMaker);

    let raw: Record<string, unknown> | null = null;
    function Probe() {
      const view = useListing(listingId);
      if (view.loading) return <p>loading</p>;
      if (view.error) return <p>error: {view.error}</p>;
      raw = view.data as unknown as Record<string, unknown>;
      return <div data-testid="bank-view">{String(raw.status)}</div>;
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.getByTestId("bank-view")).toBeTruthy();
      },
      { timeout: 30_000 }
    );

    // INV-8, on the exact body this screen consumed.
    const flat = JSON.stringify(raw).toLowerCase();
    expect(flat).not.toContain("minimumacceptable");
    expect(flat).not.toContain("minimum_acceptable");
  });
});
