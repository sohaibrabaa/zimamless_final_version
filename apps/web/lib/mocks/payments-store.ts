import { addMoney, compareMoney, subtractMoney } from "@/lib/money";
import { overdueDaysFrom } from "@/lib/payments/payments-domain";

/**
 * Post-funding mock store.
 *
 * As with the funding store, the job is to reproduce the API's *invariants* so
 * a screen developed here does not fall over on promotion:
 *
 *   - the outstanding balance is **derived** from the recorded payments, never
 *     stored, so a screen cannot come to rely on a field that does not move;
 *   - `confirm-status` refuses `PAID` while a balance remains, exactly as the
 *     API does, so the error path has a shape to render;
 *   - a fraud case never appears in a bank's or supplier's case list.
 */

export interface MockPayment {
  id: string;
  amount: string;
  paymentDate: string;
  bankReference?: string;
  bankInternalNotes?: string;
  evidenceDocumentId?: string;
  reportedAt: string;
}

interface Ledger {
  frozenOutstanding: string;
  dueDate: string;
  payments: MockPayment[];
}

export interface MockCase {
  id: string;
  type: "FRAUD" | "DISPUTE" | "WITHDRAWAL" | "RECOURSE";
  transactionId: string | null;
  status: string;
  amount: string | null;
  openedAt: string;
  /** Which org may see it, beyond the platform. */
  partyOrgId?: string;
}

export interface MockNotification {
  id: string;
  templateKey: string;
  subject: string;
  body: string;
  transactionId: string | null;
  read: boolean;
  queuedAt: string;
  recipientUserId: string;
}

const ledgers = new Map<string, Ledger>();
const cases: MockCase[] = [];
const notifications: MockNotification[] = [];

export function resetPaymentsStore(): void {
  ledgers.clear();
  cases.length = 0;
  notifications.length = 0;
}

/** Seeds a ledger for a transaction the demo funds. */
export function seedLedger(transactionId: string, frozenOutstanding: string, dueDate: string): void {
  if (!ledgers.has(transactionId)) {
    ledgers.set(transactionId, { frozenOutstanding, dueDate, payments: [] });
  }
}

function ledgerFor(transactionId: string): Ledger {
  seedLedger(transactionId, "11600.000", "2026-08-30");
  return ledgers.get(transactionId)!;
}

/** The derived balance, computed on every read — never stored. */
export function paymentHistory(transactionId: string): {
  payments: MockPayment[];
  outstandingAmount: string;
  overdueDays: number;
} {
  const ledger = ledgerFor(transactionId);
  const paid = ledger.payments.reduce((sum, p) => addMoney(sum, p.amount), "0.000");
  const remaining = subtractMoney(ledger.frozenOutstanding, paid);

  return {
    payments: ledger.payments,
    // Clamped, as the API clamps it: an overpayment is a reconciliation
    // conversation, not a negative balance on a screen.
    outstandingAmount: compareMoney(remaining, "0.000") < 0 ? "0.000" : remaining,
    // Derived from the ledger's own due date rather than hardcoded. It was 0,
    // which meant `PaymentTimeline`'s overdue-days line could never render —
    // and since no endpoint is promoted to live yet, the mock *is* what the
    // demo shows. A fixture that silently disables a screen element is worse
    // than no fixture, because the element looks built and never appears.
    overdueDays: overdueDaysFrom(ledger.dueDate, new Date()),
  };
}

export function recordBuyerPayment(
  transactionId: string,
  input: {
    amount: string;
    paymentDate: string;
    bankReference?: string;
    bankInternalNotes?: string;
  }
): { ok: true; id: string; outstandingAmount: string; state: "PARTIALLY_PAID" | "PAID" } | { ok: false } {
  const ledger = ledgerFor(transactionId);

  const payment: MockPayment = {
    id: crypto.randomUUID(),
    amount: input.amount,
    paymentDate: input.paymentDate,
    bankReference: input.bankReference,
    bankInternalNotes: input.bankInternalNotes,
    reportedAt: new Date().toISOString(),
  };
  ledger.payments.push(payment);

  const { outstandingAmount } = paymentHistory(transactionId);
  return {
    ok: true,
    id: payment.id,
    outstandingAmount,
    state: outstandingAmount === "0.000" ? "PAID" : "PARTIALLY_PAID",
  };
}

/**
 * The only route to OVERDUE, and it refuses PAID while money is outstanding —
 * the same refusal the API makes, so the 422 has a shape to render against.
 */
export function confirmPaymentStatus(
  transactionId: string,
  status: string
):
  | { ok: true; state: ConfirmableState; outstandingAmount: string }
  | { ok: false; outstandingAmount: string } {
  const { outstandingAmount } = paymentHistory(transactionId);
  if (status === "PAID" && outstandingAmount !== "0.000") {
    return { ok: false, outstandingAmount };
  }
  return { ok: true, state: status as ConfirmableState, outstandingAmount };
}

/** The three things a bank may confirm — the only route to OVERDUE anywhere. */
export type ConfirmableState = "PAID" | "PARTIALLY_PAID" | "OVERDUE";

export function addCase(entry: Omit<MockCase, "id" | "openedAt">): MockCase {
  const created: MockCase = { ...entry, id: crypto.randomUUID(), openedAt: new Date().toISOString() };
  cases.push(created);
  return created;
}

/**
 * A fraud case is filtered out for anyone but the platform.
 *
 * Reproduced here because a screen developed against a mock that showed them
 * would be a screen nobody noticed was wrong until it hit the live API — and
 * by then the mistake is "a supplier saw a fraud review naming them".
 */
export function listCases(organizationType: string, type?: string): MockCase[] {
  return cases
    .filter((c) => organizationType === "PLATFORM" || c.type !== "FRAUD")
    .filter((c) => !type || c.type === type);
}

export function addNotification(entry: Omit<MockNotification, "id" | "queuedAt" | "read">): MockNotification {
  const created: MockNotification = {
    ...entry,
    id: crypto.randomUUID(),
    read: false,
    queuedAt: new Date().toISOString(),
  };
  notifications.unshift(created);
  return created;
}

export function listNotifications(
  userId: string,
  unreadOnly: boolean
): { items: MockNotification[]; unreadCount: number; pagination: Record<string, number> } {
  const mine = notifications.filter((n) => n.recipientUserId === userId);
  const items = unreadOnly ? mine.filter((n) => !n.read) : mine;
  return {
    items,
    unreadCount: mine.filter((n) => !n.read).length,
    pagination: { page: 1, pageSize: 20, total: items.length, totalPages: 1 },
  };
}

export function markNotificationRead(id: string, userId: string): MockNotification | undefined {
  const item = notifications.find((n) => n.id === id && n.recipientUserId === userId);
  if (item) item.read = true;
  return item;
}
