/**
 * Funding + settlement mock store.
 *
 * The point of a mock is not to return plausible JSON — it is to fail in the
 * same places the real API fails, so a screen built against it does not fall
 * over on promotion. The three behaviours that matter here are the three the
 * server treats as invariants:
 *
 *   - **INV-10.** `markSent` never reaches `FUNDED`. Only `confirm` can, and
 *     only when settlement evidence is also present. Both halves, always.
 *   - **ZM-FND-009.** Wrong, expired and already-used produce one identical
 *     401 — same code, same message, same shape. If the mock distinguished
 *     them, a screen could be built that reads a difference the live API does
 *     not provide.
 *   - **INV-13.** A settlement pays once. Retrying a completed payout is a
 *     no-op that returns it unchanged rather than an error, and never a second
 *     payout.
 *
 * The plaintext code is returned exactly once per generation and stored here
 * only as a comparison target — this is a browser-side fake, not a place to
 * model server-side hashing, but nothing outside `generateOtp`'s return value
 * ever exposes it.
 */

export type SettlementStatus =
  | "PENDING"
  | "FUNDING_RECEIVED"
  | "PAYOUT_INITIATED"
  | "PAYOUT_COMPLETED"
  | "PAYOUT_FAILED"
  | "RETRYING"
  | "MANUAL_REVIEW"
  | "REVERSED";

export interface SettlementRecord {
  id: string;
  transactionId: string;
  status: SettlementStatus;
  grossFundingAmount: string;
  platformCommissionAmount: string;
  listingFeeDeducted: string;
  netSupplierPayout: string;
  providerName: string;
  providerReference: string | null;
  bankMarkedSentAt: string | null;
  fundingReceivedAt: string | null;
  payoutInitiatedAt: string | null;
  payoutCompletedAt: string | null;
  retryCount: number;
  failureReason: string | null;
}

interface OtpRecord {
  code: string;
  expiresAt: number;
  attemptsRemaining: number;
  resendsRemaining: number;
  verified: boolean;
}

const OTP_VALIDITY_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;

const settlements = new Map<string, SettlementRecord>();
const otps = new Map<string, OtpRecord>();

/** Test seam: the demo/dev flow needs a settlement without going through mark-sent. */
export function resetFundingStore(): void {
  settlements.clear();
  otps.clear();
}

export function findSettlementByTransaction(transactionId: string): SettlementRecord | undefined {
  return settlements.get(transactionId);
}

export function findSettlementById(id: string): SettlementRecord | undefined {
  for (const s of settlements.values()) if (s.id === id) return s;
  return undefined;
}

/**
 * The bank records the transfer.
 *
 * Returns `ALREADY_SENT` on a second call rather than creating a second
 * settlement — a transfer is marked sent once, and the live API's 409 is what
 * the screen has to handle.
 */
export function markSent(
  transactionId: string,
  breakdown: {
    grossFundingAmount: string;
    platformCommissionAmount: string;
    listingFeeDeducted: string;
    netSupplierPayout: string;
  },
  providerReference: string | null,
  now: Date
): { ok: true; settlement: SettlementRecord } | { ok: false; error: "ALREADY_SENT" } {
  if (settlements.has(transactionId)) return { ok: false, error: "ALREADY_SENT" };

  const settlement: SettlementRecord = {
    id: crypto.randomUUID(),
    transactionId,
    // FUNDING_RECEIVED, not anything further. The transaction moves to
    // FUNDING_CONFIRMATION_PENDING and stops there — this call cannot fund.
    status: "FUNDING_RECEIVED",
    ...breakdown,
    providerName: "DUMMY",
    providerReference,
    bankMarkedSentAt: now.toISOString(),
    fundingReceivedAt: now.toISOString(),
    payoutInitiatedAt: null,
    payoutCompletedAt: null,
    retryCount: 0,
    failureReason: null,
  };
  settlements.set(transactionId, settlement);
  return { ok: true, settlement };
}

export function generateOtp(
  transactionId: string,
  now: Date
): { ok: true; otp: string; expiresAt: string; resendsRemaining: number } | { ok: false; error: "NO_RESENDS" } {
  const existing = otps.get(transactionId);
  if (existing && existing.resendsRemaining <= 0) return { ok: false, error: "NO_RESENDS" };

  const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const expiresAt = now.getTime() + OTP_VALIDITY_MS;
  otps.set(transactionId, {
    code,
    expiresAt,
    // A regeneration restores the attempt allowance — the previous code is
    // dead, so attempts spent against it should not handicap the new one.
    attemptsRemaining: MAX_ATTEMPTS,
    resendsRemaining: existing ? existing.resendsRemaining - 1 : MAX_RESENDS,
    verified: false,
  });

  return {
    ok: true,
    otp: code,
    expiresAt: new Date(expiresAt).toISOString(),
    resendsRemaining: otps.get(transactionId)!.resendsRemaining,
  };
}

/**
 * The supplier's confirmation.
 *
 * Every failure path returns the same `INVALID` with an attempt count and
 * nothing else. There is deliberately no `EXPIRED` and no `ALREADY_USED` in
 * this return type: the distinction does not exist in the API's response, so
 * it must not exist here either, or a screen could branch on it.
 */
export function confirmOtp(
  transactionId: string,
  submitted: string,
  now: Date
):
  | { ok: true; fundedAt: string | null; transactionState: "FUNDED" | "FUNDING_CONFIRMATION_PENDING" }
  | { ok: false; error: "INVALID"; attemptsRemaining: number } {
  const record = otps.get(transactionId);

  const fail = (remaining: number) =>
    ({ ok: false as const, error: "INVALID" as const, attemptsRemaining: Math.max(0, remaining) });

  if (!record) return fail(0);
  if (record.attemptsRemaining <= 0) return fail(0);

  const expired = record.expiresAt <= now.getTime();
  const used = record.verified;
  const wrong = record.code !== submitted;

  if (expired || used || wrong) {
    record.attemptsRemaining -= 1;
    return fail(record.attemptsRemaining);
  }

  record.verified = true;

  // INV-10's second half: a correct code alone does not fund. Without the
  // bank's settlement evidence the confirmation is recorded and the
  // transaction stays pending.
  const settlement = settlements.get(transactionId);
  if (!settlement || !settlement.bankMarkedSentAt) {
    return { ok: true, fundedAt: null, transactionState: "FUNDING_CONFIRMATION_PENDING" };
  }

  // Funded — and only now does the payout run.
  runPayout(settlement, now);
  return { ok: true, fundedAt: now.toISOString(), transactionState: "FUNDED" };
}

/** The dummy rail. Succeeds unless the settlement was deliberately failed for a demo. */
function runPayout(settlement: SettlementRecord, now: Date): void {
  if (settlement.status === "PAYOUT_COMPLETED") return;
  settlement.payoutInitiatedAt = now.toISOString();
  settlement.status = "PAYOUT_COMPLETED";
  settlement.payoutCompletedAt = now.toISOString();
  settlement.providerReference = settlement.providerReference ?? `DUMMY-${settlement.id.slice(0, 8)}`;
}

/**
 * INV-13 — retry never double-pays.
 *
 * A completed settlement returns unchanged and the rail is not called again.
 * That is a success, not an error: the caller asked for the payout to have
 * happened, and it has.
 */
export function retryPayout(settlementId: string, now: Date): SettlementRecord | undefined {
  const settlement = findSettlementById(settlementId);
  if (!settlement) return undefined;
  if (settlement.status === "PAYOUT_COMPLETED") return settlement;
  if (settlement.status === "PAYOUT_INITIATED") return settlement;

  settlement.retryCount += 1;
  runPayout(settlement, now);
  return settlement;
}

/** Demo seam: force the next payout attempt to fail, so AS-03 can be shown. */
export function forcePayoutFailure(transactionId: string, reason = "RAIL_UNAVAILABLE"): void {
  const settlement = settlements.get(transactionId);
  if (!settlement) return;
  settlement.status = "PAYOUT_FAILED";
  settlement.failureReason = reason;
}
