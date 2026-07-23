import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { screen, waitFor, renderHook } from "@testing-library/react";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";
import { useSettlement, useMarkSent, generateOtp, useFundingConfirmation, OtpRejected } from "@/lib/funding/useFunding";

/**
 * The funding leg — mark-sent, the OTP round trip, and the settlement screen —
 * through the real hooks, on a disposable chain walked live.
 *
 * The staged demo FCP fixture cannot be used: confirming it would consume the
 * demo. So this stages its own OPEN listing + ACTIVE offer in SQL (the Phase 7
 * fixture pattern), walks accept → contract → both signatures through the
 * API, and then exercises the three funding hooks the screens call.
 *
 * The OTP discipline is the point worth proving live: the code exists in the
 * one API response and this test's local variable, nowhere else; a wrong code
 * comes back as `OtpRejected` carrying `attemptsRemaining` and *nothing* about
 * why; the right code ends at FUNDED — the supplier's half of INV-10.
 *
 * Once funded the chain has ledger journals and is permanent (INV-7 — the
 * append-only trigger would refuse the delete, and a journal a test can erase
 * is not a journal). Same trade the Phase 7 integration fixtures make; the
 * ZM-LIVE-* reference marks them.
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
const GROSS = "9000.000";

describe("the funding leg against the live API", () => {
  let db: pg.Client;
  let supplier: Session;
  let bankOps: Session;
  let bankApprover: Session;
  const txId = randomUUID();
  const listingId = randomUUID();
  const offerId = randomUUID();

  beforeAll(async () => {
    supplier = await signIn("supplier");
    bankOps = await signIn("bankOps");
    bankApprover = await signIn("bankApprover");

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
       VALUES ($1,$2,$3,$4,'OPEN_FOR_OFFERS','8000.000',$5)`,
      [txId, `ZM-LIVE-${txId.slice(0, 8)}`, ORG.alNoor, buyers[0].id, AL_NOOR_OWNER]
    );
    await db.query(
      `INSERT INTO invoices
         (id, transaction_id, invoice_number, einvoice_identifier, issue_date, due_date,
          subtotal_amount, tax_amount, face_value, paid_amount, outstanding_amount, fingerprint)
       VALUES ($1,$2,$3,$4, CURRENT_DATE - 10, CURRENT_DATE + 90,
               10000.000, 1600.000, 11600.000, 0, 11600.000, $5)`,
      [randomUUID(), txId, `LIVE-F-${txId.slice(0, 8)}`, `JO-EINV-LIVE-F-${txId.slice(0, 8)}`, `live-funding-${txId}`]
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
       VALUES ($1,$2,1,'OPEN_FOR_OFFERS', now(), now() + interval '1 day', now() + interval '2 days', $3)`,
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

    // Walk to CONTRACTED through the API as the entitled personas.
    const accept = await apiFetch(supplier, `/offers/${offerId}/accept`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
    if (accept.status !== 200) throw new Error(`accept: ${accept.status} ${await accept.text()}`);

    const gen = await apiFetch(supplier, `/transactions/${txId}/contract`, {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
    });
    if (gen.status !== 201) throw new Error(`contract: ${gen.status} ${await gen.text()}`);
    const contractId = ((await gen.json()) as { id: string }).id;

    for (const signer of [supplier, bankApprover]) {
      const sign = await apiFetch(signer, `/contracts/${contractId}/sign`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ accepted: true }),
      });
      if (sign.status !== 200 && sign.status !== 201) {
        throw new Error(`sign: ${sign.status} ${await sign.text()}`);
      }
    }
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  it("marks the transfer sent through useMarkSent and renders the settlement", async () => {
    useSessionForApi(bankOps);

    // The mutation, exactly as the bank's funding screen performs it. The
    // hook returns nothing by design (the mark-sent response body is
    // undeclared in the contract); the screen reloads the settlement.
    const { result } = renderHook(() => useMarkSent());
    await result.current.markSent(txId, { providerReference: `WIRE-LIVE-${txId.slice(0, 8)}` });

    function Probe() {
      const settlement = useSettlement(txId);
      if (settlement.loading) return <p>loading</p>;
      if (settlement.error) return <p>error: {settlement.error}</p>;
      if (!settlement.data) return <p>no settlement</p>;
      return (
        <div data-testid="settlement">
          {settlement.data.status} {String((settlement.data as Record<string, unknown>).grossFundingAmount)}
        </div>
      );
    }

    renderLive(<Probe />);
    await waitFor(
      () => {
        const errored = screen.queryByText(/^error:/);
        expect(errored, errored?.textContent ?? "").toBeNull();
        expect(screen.getByTestId("settlement")).toBeTruthy();
      },
      { timeout: 30_000 }
    );
    const text = screen.getByTestId("settlement").textContent ?? "";
    expect(text).toContain("FUNDING_RECEIVED");
    expect(text).toContain(GROSS);
  }, 90_000);

  it("walks the OTP round trip: bank issues, wrong code rejected blindly, right code funds", async () => {
    // The bank issues the code.
    useSessionForApi(bankOps);
    const issued = await generateOtp(txId);
    expect(issued.otp).toMatch(/^\d{6}$/);
    expect(typeof issued.expiresAt).toBe("string");

    // The supplier confirms — wrong code first.
    useSessionForApi(supplier);
    const { result } = renderHook(() => useFundingConfirmation());

    const wrong = issued.otp === "000000" ? "111111" : "000000";
    let rejected: OtpRejected | null = null;
    try {
      await result.current.confirm(txId, wrong);
    } catch (err) {
      if (err instanceof OtpRejected) rejected = err;
      else throw err;
    }
    expect(rejected).not.toBeNull();
    // The one detail the server discloses — and the only one the client may
    // know: how many attempts remain. Not why the code failed.
    expect(typeof rejected!.attemptsRemaining).toBe("number");

    // The right code ends at FUNDED.
    const confirmed = await result.current.confirm(txId, issued.otp);
    expect(confirmed.transactionState).toBe("FUNDED");

    const { rows } = await db.query<{ state: string }>(
      `SELECT state FROM receivable_transactions WHERE id = $1`,
      [txId]
    );
    expect(rows[0].state).toBe("FUNDED");
  }, 90_000);
});
