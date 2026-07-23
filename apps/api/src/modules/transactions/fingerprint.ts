import { createHash } from 'node:crypto';

/**
 * Invoice fingerprinting for duplicate detection (ZM-VER-001).
 *
 * The phase file names the inputs: **parties + invoice number + date +
 * value + tax**. Getting this function right matters more than most — it is
 * what stops the same receivable being financed twice by two banks, which
 * is the single most expensive fraud this platform is exposed to.
 *
 * Two failure directions, both bad and pulling in opposite ways:
 *
 *   Too strict (a byte-exact hash of raw input) and a duplicate slips
 *   through because one supplier typed "INV-2026-0001" and the other
 *   "inv 2026 0001". The fraud this check exists to catch is committed by
 *   someone who *wants* to evade it, so incidental formatting must not be
 *   part of the key.
 *
 *   Too loose (dropping the invoice number, or rounding the amount) and
 *   honest suppliers collide — two genuine invoices to the same buyer on
 *   the same day for the same amount are entirely ordinary in, say,
 *   recurring deliveries. A false collision blocks a real invoice and opens
 *   a fraud review against someone who did nothing wrong.
 *
 * The normalization below is therefore deliberately narrow: case, spacing
 * and separator punctuation are removed from identifiers because they carry
 * no meaning, and nothing else is touched. Amounts keep full 3-dp precision.
 *
 * The buyer is identified by national establishment number rather than by
 * our internal buyer id, so the fingerprint is stable across a buyer record
 * being merged or recreated — an internal id would let a duplicate through
 * whenever the two suppliers happened to resolve to different rows.
 *
 * **The supplier is deliberately NOT part of the key** (v2; v1 included it
 * and was wrong). ZM-VER-001 requires uniqueness *platform-wide*, and the
 * fraud the requirement exists to stop is one receivable financed twice —
 * which is precisely the case where the *claimant* differs. Keying on the
 * supplier meant a second business claiming the same buyer's invoice
 * produced a different hash and passed straight through to ELIGIBLE. The
 * two seeded `INV-2026-0003` PDFs are that scenario, and they must collide.
 *
 * The cost of leaving the supplier out is a false collision when two
 * unrelated suppliers happen to issue the same invoice number to the same
 * buyer on the same day for the same amount down to the third decimal. That
 * is vanishingly unlikely, it blocks rather than approves, and it opens a
 * review record a human resolves — the safe direction to be wrong in.
 */

export const FINGERPRINT_VERSION = 'v2';

export interface FingerprintInput {
  /** Buyer's national establishment number. */
  buyerEstablishmentNumber: string;
  invoiceNumber: string;
  /** ISO date, YYYY-MM-DD. */
  issueDate: string;
  /** 3-dp strings. Never JS numbers — precision is part of the identity. */
  faceValue: string;
  taxAmount: string;
}

/**
 * Fold an identifier to its meaningful content.
 *
 * Upper-cases, then strips everything that is not a letter or digit. So
 * "INV-2026/0001", "inv 2026 0001" and "Inv#2026-0001" all become
 * "INV20260001" — the same invoice, however it was typed.
 */
export function normalizeIdentifier(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Amounts are compared at full 3-dp precision, as stored. */
function normalizeAmount(value: string): string {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(
      `Fingerprint amounts must be plain decimal strings, got "${value}". ` +
        'A JS number would already have lost precision.',
    );
  }
  // Re-render to exactly 3 dp so "1600" and "1600.000" fingerprint alike
  // without going through a float.
  const [whole, fraction = ''] = trimmed.split('.');
  return `${whole}.${(fraction + '000').slice(0, 3)}`;
}

/**
 * The canonical string the hash is taken over.
 *
 * Returned separately from the hash so a collision can be explained. When a
 * duplicate blocks a submission, a reviewer needs to see *which* facts
 * matched, and a bare hex digest tells them nothing.
 */
export function fingerprintSource(input: FingerprintInput): string {
  return [
    FINGERPRINT_VERSION,
    normalizeIdentifier(input.buyerEstablishmentNumber),
    normalizeIdentifier(input.invoiceNumber),
    input.issueDate.trim(),
    normalizeAmount(input.faceValue),
    normalizeAmount(input.taxAmount),
  ].join('|');
}

export function computeFingerprint(input: FingerprintInput): string {
  return createHash('sha256').update(fingerprintSource(input)).digest('hex');
}
