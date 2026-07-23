import type { components } from "@/lib/api/generated/schema";

export type Extraction = components["schemas"]["Extraction"];
export type QrValidationStatus = NonNullable<NonNullable<Extraction["qr"]>["validationStatus"]>;

/**
 * Reading the OCR/QR extraction, and comparing it against what the supplier
 * actually typed.
 *
 * The governing rule is ZM-DOC-006: the machine's output and the supplier's
 * correction are **both** preserved and independently retrievable, and a
 * correction never erases the extracted value. That is a server guarantee —
 * `/documents/{id}/extraction` keeps `ocr.rawOutput` separate from
 * `ocr.extractedFields` — but it is also a UI obligation: the screen must say
 * so, or a supplier will reasonably believe that typing over a pre-filled box
 * discards what the machine read. `Both values are kept` copy is not decorative.
 *
 * `extractedFields` is typed `additionalProperties: true` in the frozen
 * contract, so this module is the one place that assumes a shape for it: a flat
 * map of invoice field name → scalar. Anything else degrades to "no pre-fill
 * available" rather than throwing or half-filling the form.
 */

/** Invoice fields the wizard can pre-fill and compare. */
export const COMPARABLE_FIELDS = [
  "invoiceNumber",
  "einvoiceIdentifier",
  "issueDate",
  "dueDate",
  "subtotalAmount",
  "taxAmount",
  "faceValue",
] as const;

export type ComparableField = (typeof COMPARABLE_FIELDS)[number];

export interface FieldComparison {
  field: ComparableField;
  /** What OCR read, if it read this field at all. */
  ocrValue: string | null;
  /** What the QR payload carried, if it was parsed and carried this field. */
  qrValue: string | null;
  /** What the supplier currently has in the form. */
  userValue: string;
  /**
   * True when the supplier's value differs from a machine value that exists.
   * A field the machine never read is **not** a mismatch — absence of an
   * extracted value is not evidence of a discrepancy.
   */
  mismatch: boolean;
}

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "boolean") return String(value);
  // Numbers are deliberately stringified rather than parsed: money arrives as
  // a decimal string and must stay one (brief §5). A JSON number here means
  // the source sent something unexpected, and String() preserves it verbatim
  // for the supplier to see rather than routing it through float arithmetic.
  if (typeof value === "number") return String(value);
  return null;
}

function readField(
  fields: Record<string, unknown> | undefined,
  field: ComparableField
): string | null {
  if (!fields || typeof fields !== "object") return null;
  return scalar(fields[field]);
}

/**
 * The machine's suggestion for a field: QR first, then OCR.
 *
 * QR wins because it is a decoded payload rather than a reading of pixels —
 * but only when the QR actually parsed. `UNPARSED` means the payload did not
 * match a known schema (ZM-DOC-010 requires degrading to manual review rather
 * than guessing), so its fields are not trusted for pre-fill.
 */
export function suggestedValue(
  extraction: Extraction | null | undefined,
  field: ComparableField
): string | null {
  if (!extraction) return null;
  const qrUsable = extraction.qr?.parsed === true && extraction.qr.validationStatus !== "UNPARSED";
  const qr = qrUsable
    ? readField(extraction.qr?.extractedFields as Record<string, unknown> | undefined, field)
    : null;
  return qr ?? readField(extraction.ocr?.extractedFields as Record<string, unknown> | undefined, field);
}

/** Pre-fill values for the invoice form. Never overwrites what the supplier typed. */
export function prefillFromExtraction(
  extraction: Extraction | null | undefined,
  current: Partial<Record<ComparableField, string>>
): Partial<Record<ComparableField, string>> {
  const next: Partial<Record<ComparableField, string>> = { ...current };
  for (const field of COMPARABLE_FIELDS) {
    if ((current[field] ?? "").trim() !== "") continue;
    const suggestion = suggestedValue(extraction, field);
    if (suggestion !== null) next[field] = suggestion;
  }
  return next;
}

/**
 * Field-by-field comparison driving the mismatch highlighting.
 *
 * Only fields with at least one machine value are returned — a row saying
 * "OCR: —, QR: —, you: 1250.000" is noise, and rendering it as a comparison
 * implies a check happened that did not.
 */
export function compareFields(
  extraction: Extraction | null | undefined,
  entered: Partial<Record<ComparableField, string>>
): FieldComparison[] {
  const qrUsable = extraction?.qr?.parsed === true && extraction.qr.validationStatus !== "UNPARSED";
  const comparisons: FieldComparison[] = [];

  for (const field of COMPARABLE_FIELDS) {
    const ocrValue = readField(
      extraction?.ocr?.extractedFields as Record<string, unknown> | undefined,
      field
    );
    const qrValue = qrUsable
      ? readField(extraction?.qr?.extractedFields as Record<string, unknown> | undefined, field)
      : null;
    if (ocrValue === null && qrValue === null) continue;

    const userValue = (entered[field] ?? "").trim();
    const machineValues = [ocrValue, qrValue].filter((v): v is string => v !== null);
    // An empty form field is not yet a mismatch — the supplier has not
    // disagreed with anything, they simply have not filled it in.
    const mismatch = userValue !== "" && !machineValues.includes(userValue);

    comparisons.push({ field, ocrValue, qrValue, userValue, mismatch });
  }

  return comparisons;
}

export function hasMismatches(comparisons: readonly FieldComparison[]): boolean {
  return comparisons.some((c) => c.mismatch);
}

/**
 * QR status presentation. `UNPARSED` is the ZM-DOC-010 case and gets its own
 * explanatory copy: the invoice is not rejected and the supplier has done
 * nothing wrong — the payload simply did not match a schema we recognise, so a
 * person will look at it.
 */
export function qrStatusLabelKey(status: QrValidationStatus | undefined): string {
  switch (status) {
    case "VALID":
      return "invoices.qr.status.VALID";
    case "INVALID":
      return "invoices.qr.status.INVALID";
    case "UNAVAILABLE":
      return "invoices.qr.status.UNAVAILABLE";
    case "UNPARSED":
      return "invoices.qr.status.UNPARSED";
    default:
      return "invoices.qr.status.PENDING";
  }
}

export function qrStatusExplanationKey(status: QrValidationStatus | undefined): string | undefined {
  switch (status) {
    case "INVALID":
      return "invoices.qr.explain.INVALID";
    case "UNAVAILABLE":
      return "invoices.qr.explain.UNAVAILABLE";
    case "UNPARSED":
      return "invoices.qr.explain.UNPARSED";
    default:
      return undefined;
  }
}

/** Only VALID is a positive signal; everything else is neutral, never adverse. */
export function qrStatusTone(status: QrValidationStatus | undefined): "success" | "neutral" {
  return status === "VALID" ? "success" : "neutral";
}
