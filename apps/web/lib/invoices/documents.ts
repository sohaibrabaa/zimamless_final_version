/**
 * Document policy for the invoice wizard (ZM-DOC-001/002).
 *
 * The electronic invoice is **mandatory** for every V3 submission — a
 * submission without one cannot proceed. Everything else is `CONFIGURABLE`
 * per bank or platform policy, which V3 has no endpoint to read: there is no
 * `GET /admin/document-policy` in the contract or the overlay. So the optional
 * documents below are offered as supporting evidence and none is *required*
 * client-side. If a policy endpoint lands, this list becomes its consumer;
 * until then the client must not invent a requirement the server does not
 * enforce, because the supplier would be blocked by a rule that does not exist.
 */

export type DocumentType =
  | "ELECTRONIC_INVOICE"
  | "PURCHASE_ORDER"
  | "DELIVERY_NOTE"
  | "STATEMENT_OF_ACCOUNT"
  | "CREDIT_NOTE"
  | "OTHER";

export interface DocumentTypeSpec {
  type: DocumentType;
  labelKey: string;
  descriptionKey: string;
  /** ZM-DOC-001 — true for the e-invoice only. */
  mandatory: boolean;
}

export const EINVOICE_SPEC: DocumentTypeSpec = {
  type: "ELECTRONIC_INVOICE",
  labelKey: "invoices.documents.type.ELECTRONIC_INVOICE",
  descriptionKey: "invoices.documents.desc.ELECTRONIC_INVOICE",
  mandatory: true,
};

/** Step 3's list. The e-invoice is not here — it is step 2's subject. */
export const SUPPORTING_DOCUMENT_TYPES: readonly DocumentTypeSpec[] = [
  {
    type: "PURCHASE_ORDER",
    labelKey: "invoices.documents.type.PURCHASE_ORDER",
    descriptionKey: "invoices.documents.desc.PURCHASE_ORDER",
    mandatory: false,
  },
  {
    type: "DELIVERY_NOTE",
    labelKey: "invoices.documents.type.DELIVERY_NOTE",
    descriptionKey: "invoices.documents.desc.DELIVERY_NOTE",
    mandatory: false,
  },
  {
    type: "STATEMENT_OF_ACCOUNT",
    labelKey: "invoices.documents.type.STATEMENT_OF_ACCOUNT",
    descriptionKey: "invoices.documents.desc.STATEMENT_OF_ACCOUNT",
    mandatory: false,
  },
  {
    type: "CREDIT_NOTE",
    labelKey: "invoices.documents.type.CREDIT_NOTE",
    descriptionKey: "invoices.documents.desc.CREDIT_NOTE",
    mandatory: false,
  },
] as const;

export const ACCEPTED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;

/** 15 MB. A client-side ceiling only — the server records the real size (ZM-DOC-003). */
export const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;

export type FileRejection = "MIME_TYPE" | "TOO_LARGE";

export function rejectFile(file: { type: string; size: number }): FileRejection | null {
  if (!ACCEPTED_MIME_TYPES.includes(file.type as (typeof ACCEPTED_MIME_TYPES)[number])) {
    return "MIME_TYPE";
  }
  if (file.size > MAX_FILE_SIZE_BYTES) return "TOO_LARGE";
  return null;
}

export function fileRejectionKey(rejection: FileRejection): string {
  return rejection === "MIME_TYPE"
    ? "invoices.documents.error.mimeType"
    : "invoices.documents.error.tooLarge";
}
