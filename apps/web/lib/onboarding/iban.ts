/**
 * Client-side IBAN sanity check for the disbursement step (requirements §5.2).
 *
 * This is input hygiene only — the authoritative check is the server's account
 * ownership verification (§5.4 step 8, ZM-SON-012 "inability to establish
 * ownership of the bank account"). A locally valid IBAN is never treated as a
 * verified one.
 *
 * Digit values come from a lookup table rather than `Number()`/`parseInt` so
 * the money-safety lint rule stays satisfiable repo-wide without exceptions.
 */

const DIGIT_VALUE: Record<string, number> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
};

/** A..Z → 10..35, per the ISO 13616 conversion. */
function letterValue(ch: string): number | null {
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65 + 10;
  return null;
}

export function normalizeIban(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/** Jordanian IBANs are `JO` + 2 check digits + 26 alphanumerics = 30 characters. */
const JO_IBAN_LENGTH = 30;

export type IbanProblem = "FORMAT" | "COUNTRY" | "LENGTH" | "CHECKSUM";

export function validateIban(raw: string): IbanProblem | null {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return "FORMAT";
  if (!iban.startsWith("JO")) return "COUNTRY";
  if (iban.length !== JO_IBAN_LENGTH) return "LENGTH";

  // ISO 7064 mod-97: move the first four characters to the end, expand letters
  // to digits, then take mod 97 chunk by chunk to stay inside safe integers.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digit = DIGIT_VALUE[ch];
    if (digit !== undefined) {
      remainder = (remainder * 10 + digit) % 97;
      continue;
    }
    const letter = letterValue(ch);
    if (letter === null) return "FORMAT";
    remainder = (remainder * 100 + letter) % 97;
  }
  return remainder === 1 ? null : "CHECKSUM";
}

/** Groups of four for readability. Always rendered inside an LTR bidi island (RTL checklist #4). */
export function formatIbanForDisplay(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

export function ibanErrorKey(problem: IbanProblem): string {
  return `onboarding.bankAccount.ibanError.${problem}`;
}
