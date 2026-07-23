import { Money } from '../../common/money/money';

/**
 * ZM-CON-006 — what must be true before a contract may be generated.
 *
 * Four conditions, and the requirement states them as a conjunction: the
 * invoice has not changed, expired or been cancelled; mandatory offer
 * conditions are fulfilled **or explicitly waived with a record**; the
 * supplier's declarations are reconfirmed; and the supplier's bank account is
 * verified.
 *
 * This file is pure. It takes facts and returns findings, so the whole set
 * can be tested without a database and — more importantly — so the answer to
 * "why can I not generate the contract?" is a **list**, not the first failure
 * the service happened to hit. A supplier who fixes one thing and is then
 * told about the next is being drip-fed; one response naming everything
 * outstanding is the difference between a checklist and a guessing game.
 *
 * Note what is NOT checked here: whether the platform has been paid. The
 * listing fee is an obligation, not a gate — ZM-FEE-002 makes it payable at
 * activation regardless of outcome, and refusing to contract over an unpaid
 * fee would hold a financing deal hostage to a 25 JOD invoice.
 */

export interface PreContractFacts {
  readonly invoiceOutstanding: Money;
  readonly invoiceDueDate: string;
  /** True if the invoice row's fingerprint no longer matches the snapshot's. */
  readonly invoiceAltered: boolean;
  readonly invoiceCancelled: boolean;
  /** As of the TimeProvider's now, at the caller. */
  readonly invoiceExpired: boolean;
  readonly snapshotGross: Money;
  readonly conditions: readonly {
    readonly id: string;
    readonly title: string;
    readonly isMandatory: boolean;
    readonly fulfilment: 'PENDING' | 'FULFILLED' | 'WAIVED' | 'FAILED';
    readonly waiverReason: string | null;
  }[];
  readonly declarationsAffirmed: boolean;
  readonly bankAccountVerified: boolean;
}

export interface PreContractFinding {
  readonly code: string;
  readonly message: string;
}

export function preContractFindings(facts: PreContractFacts): PreContractFinding[] {
  const findings: PreContractFinding[] = [];

  if (facts.invoiceCancelled) {
    findings.push({
      code: 'INVOICE_CANCELLED',
      message: 'The invoice has been cancelled and can no longer be financed.',
    });
  }

  if (facts.invoiceAltered) {
    findings.push({
      code: 'INVOICE_ALTERED',
      message:
        'The invoice has changed since the offer was accepted. The accepted terms were agreed ' +
        'against a different document.',
    });
  }

  if (facts.invoiceExpired) {
    findings.push({
      code: 'INVOICE_PAST_DUE',
      message: `The invoice fell due on ${facts.invoiceDueDate} and is no longer a future receivable.`,
    });
  }

  // The accepted gross must still fit inside what the invoice is worth. This
  // is INV-3 re-checked at contract time rather than trusted from acceptance:
  // a buyer part-payment between the two moments legitimately reduces the
  // outstanding amount, and contracting to advance more than the receivable
  // can repay is exactly the situation INV-3 exists to prevent.
  if (!facts.invoiceOutstanding.greaterThanOrEqual(facts.snapshotGross)) {
    findings.push({
      code: 'GROSS_EXCEEDS_OUTSTANDING',
      message:
        'The invoice outstanding amount has fallen below the accepted gross funding amount.',
    });
  }

  for (const condition of facts.conditions) {
    if (!condition.isMandatory) continue;

    if (condition.fulfilment === 'FULFILLED') continue;

    // A waiver counts, but only a *recorded* one. ZM-CON-006 says "explicitly
    // waived with a record", and a WAIVED row with no reason is the exact
    // shape of someone clicking through a blocker — so it is treated as
    // outstanding rather than as satisfied.
    if (condition.fulfilment === 'WAIVED') {
      if (condition.waiverReason && condition.waiverReason.trim().length > 0) continue;
      findings.push({
        code: 'CONDITION_WAIVED_WITHOUT_RECORD',
        message: `The mandatory condition “${condition.title}” is marked waived with no reason recorded.`,
      });
      continue;
    }

    findings.push({
      code: 'CONDITION_OUTSTANDING',
      message: `The mandatory condition “${condition.title}” is ${condition.fulfilment.toLowerCase()}.`,
    });
  }

  if (!facts.declarationsAffirmed) {
    findings.push({
      code: 'DECLARATIONS_NOT_REAFFIRMED',
      message: 'The supplier’s declarations must be reconfirmed before the contract is generated.',
    });
  }

  if (!facts.bankAccountVerified) {
    findings.push({
      code: 'BANK_ACCOUNT_NOT_VERIFIED',
      message:
        'The supplier’s bank account is not verified. Funds must not be committed to an ' +
        'unverified destination.',
    });
  }

  return findings;
}

/** Convenience for the call sites that only need the verdict. */
export function passesPreContractChecks(facts: PreContractFacts): boolean {
  return preContractFindings(facts).length === 0;
}
