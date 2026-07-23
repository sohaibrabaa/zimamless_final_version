import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { AppException } from '../../common/errors/app.exception';
import { ActorContext } from '../onboarding/onboarding.service';
import {
  ALLOWED_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  StorageService,
} from './storage.service';
import { contentMatchesDeclared, sniffContentType } from './content-sniff';
import { MlClientService, MlExtraction } from './ml-client.service';

/**
 * Documents: signed URLs, content hashing, and OCR/QR extraction storage.
 *
 * The authorization rule (ZM-DOC-004) is the whole point of this module and
 * is enforced in exactly one place — `requireReadable()`. Every route that
 * hands out a URL or reveals a document's contents goes through it. The
 * checkpoint's "a bank JWT cannot fetch the supplier's document" drill is a
 * test of that function.
 */

export type DocumentType =
  | 'COMMERCIAL_REGISTRATION'
  | 'TAX_CERTIFICATE'
  | 'BUSINESS_LICENSE'
  | 'BANK_ACCOUNT_EVIDENCE'
  | 'SIGNATORY_AUTHORIZATION'
  | 'ELECTRONIC_INVOICE'
  | 'PURCHASE_ORDER'
  | 'DELIVERY_EVIDENCE'
  | 'STATEMENT_OF_ACCOUNT'
  | 'CREDIT_NOTE'
  | 'CONTRACT_DOCUMENT'
  | 'CASE_EVIDENCE'
  | 'OTHER';

/** Mirrors the frozen `document_type` enum exactly. */
export const DOCUMENT_TYPES: readonly DocumentType[] = [
  'COMMERCIAL_REGISTRATION',
  'TAX_CERTIFICATE',
  'BUSINESS_LICENSE',
  'BANK_ACCOUNT_EVIDENCE',
  'SIGNATORY_AUTHORIZATION',
  'ELECTRONIC_INVOICE',
  'PURCHASE_ORDER',
  'DELIVERY_EVIDENCE',
  'STATEMENT_OF_ACCOUNT',
  'CREDIT_NOTE',
  'CONTRACT_DOCUMENT',
  'CASE_EVIDENCE',
  'OTHER',
];

export interface DocumentRow {
  id: string;
  owner_org_id: string;
  document_type: DocumentType;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  file_hash: string;
  subject_type: string | null;
  subject_id: string | null;
  uploaded_by: string;
  uploaded_at: Date;
}

export interface ExtractionRow {
  id: string;
  document_id: string;
  extraction_kind: 'OCR' | 'QR';
  raw_output: Record<string, unknown>;
  extracted_fields: Record<string, string>;
  confidence: string | null;
  engine_version: string | null;
  succeeded: boolean;
  failure_reason: string | null;
  created_at: Date;
}

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly ml: MlClientService,
  ) {}

  // ------------------------------------------------------------------
  // Upload
  // ------------------------------------------------------------------

  /**
   * Reserve a document row and hand back a short-lived signed upload URL.
   *
   * The row is created *before* the bytes arrive, which is deliberate: the
   * document id is what the client attaches to a transaction, and it has to
   * exist for the client to reference. The consequence is that a row can
   * outlive an upload the supplier abandoned — `file_hash` stays empty until
   * the bytes are confirmed, and `finalize()` is what makes a document real.
   */
  async createUploadUrl(
    ctx: ActorContext,
    input: {
      documentType: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      subjectType?: string;
      subjectId?: string;
    },
  ): Promise<{ documentId: string; uploadUrl: string; expiresAt: string }> {
    if (!DOCUMENT_TYPES.includes(input.documentType as DocumentType)) {
      throw AppException.validation(
        `Unknown documentType. Expected one of: ${DOCUMENT_TYPES.join(', ')}.`,
        { field: 'documentType', value: input.documentType },
      );
    }
    if (!ALLOWED_MIME_TYPES.includes(input.mimeType)) {
      throw AppException.validation(
        `Unsupported file type. Accepted: ${ALLOWED_MIME_TYPES.join(', ')}.`,
        { field: 'mimeType', value: input.mimeType },
      );
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
      throw AppException.validation('sizeBytes must be a positive integer.', {
        field: 'sizeBytes',
      });
    }
    if (input.sizeBytes > MAX_DOCUMENT_BYTES) {
      throw AppException.validation(
        `The file exceeds the ${MAX_DOCUMENT_BYTES} byte limit.`,
        { field: 'sizeBytes', maxBytes: MAX_DOCUMENT_BYTES },
      );
    }

    // A document may only be attached to something the caller can already
    // reach. Without this, a supplier could attach a file to another
    // organization's transaction and have it appear on their screen.
    if (input.subjectType && input.subjectId) {
      await this.requireSubjectWritable(ctx, input.subjectType, input.subjectId);
    }

    const created = await this.db.queryOne<{ id: string }>(
      `INSERT INTO documents
         (owner_org_id, document_type, storage_path, file_name, mime_type,
          size_bytes, file_hash, subject_type, subject_id, uploaded_by)
       VALUES ($1, $2::document_type, '', $3, $4, $5, '', $6, $7, $8)
       RETURNING id`,
      [
        ctx.organizationId,
        input.documentType,
        input.fileName,
        input.mimeType,
        input.sizeBytes,
        input.subjectType ?? null,
        input.subjectId ?? null,
        ctx.userId,
      ],
    );
    if (!created) throw new Error('Failed to create the document row.');

    const path = this.storage.pathFor(ctx.organizationId, created.id, input.fileName);
    const signed = await this.storage.createSignedUpload(path);

    await this.db.query(`UPDATE documents SET storage_path = $2 WHERE id = $1`, [
      created.id,
      path,
    ]);

    return {
      documentId: created.id,
      uploadUrl: signed.signedUrl,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /**
   * Hash the stored bytes and run extraction, once, on first need.
   *
   * The upload goes straight from the browser to Supabase Storage, so the
   * API never sees the bytes at upload time and cannot hash them there.
   * Something has to notice the file has arrived.
   *
   * The obvious design — a `POST /documents/{id}/finalize` for the client
   * to call after its PUT — is not available: it is not in the frozen
   * contract or the approved overlay, Agent B could not generate it, and
   * hard rule 1 forbids inventing an endpoint without a recorded ruling.
   * The conformance gate refuses it, correctly.
   *
   * So finalization is lazy instead, triggered by the first thing that
   * genuinely needs the file's content: reading its extraction, or
   * submitting the transaction it is attached to. That turns out to be
   * better than an explicit call regardless — a client that forgot to
   * finalize would otherwise leave an unhashed document that silently
   * failed its integrity check later.
   *
   * The hash is computed from what is actually in storage, never from a
   * value the client supplied (ZM-DOC-003). A client-supplied hash would
   * make the file-integrity check self-certifying: the uploader attesting
   * to their own file is not evidence of anything.
   *
   * Idempotent — a document that already has a hash is returned untouched,
   * so this never re-runs OCR on every read.
   */
  async ensureFinalized(document: DocumentRow): Promise<DocumentRow> {
    if (document.file_hash) return document;
    if (!document.storage_path) return document;

    const bytes = await this.storage.download(document.storage_path);
    if (!bytes) {
      // The signed URL was issued but nothing was ever uploaded to it. Not
      // an error here: the caller's own check (a missing e-invoice, an
      // empty extraction) reports it in terms the supplier can act on.
      this.logger.warn(`Document ${document.id} has no stored object yet.`);
      return document;
    }

    // This is the one moment the server holds the actual bytes. The declared
    // mimeType was a claim the client made when it reserved the upload; a
    // signed PUT URL will accept anything, so a caller could store an HTML
    // page or a script under an `application/pdf` label. Refuse a document
    // whose leading bytes contradict its declared type before it is hashed,
    // OCR'd, or attached to a transaction — an invalid document must not
    // become a "real" one. The mismatch is logged (never the bytes) and left
    // unfinalized; the supplier's remedy is to re-upload the correct file.
    if (!contentMatchesDeclared(document.mime_type, bytes)) {
      this.logger.warn(
        `Document ${document.id} declared ${document.mime_type} but its bytes look like ` +
          `${sniffContentType(bytes) ?? 'an unrecognized format'}. Refusing to finalize.`,
      );
      throw AppException.validation(
        'The uploaded file does not match its declared type. Re-upload the correct file.',
        { field: 'file', declaredType: document.mime_type },
      );
    }

    const hash = createHash('sha256').update(bytes).digest('hex');
    await this.db.query(`UPDATE documents SET file_hash = $2, size_bytes = $3 WHERE id = $1`, [
      document.id,
      hash,
      bytes.length,
    ]);

    const finalized = { ...document, file_hash: hash, size_bytes: String(bytes.length) };
    await this.runExtraction(finalized, bytes);
    return finalized;
  }

  /**
   * Run OCR and QR extraction and store both readings.
   *
   * Two rows, one per `extraction_kind`, because they are two independent
   * readings that fail independently — a document can have perfectly
   * readable text and an unreadable code, and one row could not record that.
   *
   * ZM-DOC-006 lives here: `raw_output` is the machine's word, stored
   * separately from anything the supplier later types. Nothing in this
   * service ever updates a raw_output.
   */
  async runExtraction(document: DocumentRow, bytes: Buffer): Promise<MlExtraction> {
    const extraction = await this.ml.extract(bytes, document.file_name, document.mime_type);

    await this.db.transaction(async (client) => {
      // Re-extraction supersedes nothing: previous rows stay. The retrieval
      // path takes the newest per kind, and the history is the evidence of
      // what the machine said each time it was asked.
      await client.query(
        `INSERT INTO document_extractions
           (document_id, extraction_kind, raw_output, extracted_fields, confidence,
            engine_version, succeeded, failure_reason)
         VALUES ($1, 'OCR', $2::jsonb, $3::jsonb, $4::numeric, $5, $6, $7)`,
        [
          document.id,
          JSON.stringify(extraction.ocr.rawOutput ?? {}),
          JSON.stringify(extraction.ocr.extractedFields ?? {}),
          extraction.ocr.confidence ?? 0,
          extraction.engineVersion,
          extraction.ocr.available,
          extraction.ocr.unavailableReason,
        ],
      );

      await client.query(
        `INSERT INTO document_extractions
           (document_id, extraction_kind, raw_output, extracted_fields, confidence,
            engine_version, succeeded, failure_reason)
         VALUES ($1, 'QR', $2::jsonb, $3::jsonb, NULL, $4, $5, $6)`,
        [
          document.id,
          JSON.stringify(extraction.qr.rawOutput ?? {}),
          JSON.stringify(extraction.qr.extractedFields ?? {}),
          extraction.engineVersion,
          extraction.qr.parsed,
          extraction.qr.parsed ? null : extraction.qr.validationStatus,
        ],
      );
    });

    if (!extraction.serviceAvailable) {
      this.logger.warn(
        `Document ${document.id} stored without extraction — the ML service was unreachable. ` +
          'Recorded as unavailable, not as an adverse finding.',
      );
    }
    return extraction;
  }

  // ------------------------------------------------------------------
  // Read + authorization
  // ------------------------------------------------------------------

  async findById(id: string): Promise<DocumentRow | null> {
    return this.db.queryOne<DocumentRow>(
      `SELECT id, owner_org_id, document_type, storage_path, file_name, mime_type,
              size_bytes::text, file_hash, subject_type, subject_id, uploaded_by, uploaded_at
         FROM documents WHERE id = $1`,
      [id],
    );
  }

  /**
   * The single server-side authorization check for document access
   * (ZM-DOC-004).
   *
   * Rules, in the order they are applied:
   *   - the owning organization may read its own documents;
   *   - platform staff may read any document;
   *   - a bank may read a document only when it is attached to a
   *     transaction the bank has been given sight of — and in Phase 3 no
   *     such link exists yet, so a bank reads nothing. That is the
   *     checkpoint's signed-URL drill.
   *
   * A caller who may not read gets 404, not 403. 403 would confirm that a
   * document with that id exists, which is an enumeration oracle over every
   * document on the platform — the same reasoning that governs the
   * onboarding and government reads.
   */
  async requireReadable(id: string, ctx: ActorContext): Promise<DocumentRow> {
    const document = await this.findById(id);
    if (!document) throw AppException.notFound('Document');

    if (ctx.organizationType === 'PLATFORM') return document;
    if (document.owner_org_id === ctx.organizationId) return document;

    if (ctx.organizationType === 'BANK' && (await this.bankMaySee(ctx.organizationId, document))) {
      return document;
    }

    this.logger.warn(
      `Refused document ${id} to organization ${ctx.organizationId} (${ctx.organizationType}).`,
    );
    throw AppException.notFound('Document');
  }

  /**
   * Whether a bank may see a document attached to a transaction.
   *
   * Sight of a transaction comes from a listing the bank was made eligible
   * for, or an offer it placed — both arrive in Phase 5. Until then this is
   * correctly always false, and it is written as a real query rather than
   * `return false` so that the rule is expressed once and starts working the
   * moment those tables have rows, rather than being a TODO someone has to
   * remember.
   */
  private async bankMaySee(bankOrgId: string, document: DocumentRow): Promise<boolean> {
    if (document.subject_type !== 'TRANSACTION' || !document.subject_id) return false;
    const row = await this.db.queryOne(
      `SELECT 1
         FROM listings l
         LEFT JOIN bank_eligibility e ON e.listing_id = l.id AND e.bank_org_id = $2
         LEFT JOIN bank_offers o      ON o.listing_id = l.id AND o.bank_org_id = $2
        WHERE l.transaction_id = $1
          AND (e.id IS NOT NULL OR o.id IS NOT NULL)
        LIMIT 1`,
      [document.subject_id, bankOrgId],
    );
    return row !== null;
  }

  /** The caller must be able to write to whatever they are attaching to. */
  private async requireSubjectWritable(
    ctx: ActorContext,
    subjectType: string,
    subjectId: string,
  ): Promise<void> {
    if (ctx.organizationType === 'PLATFORM') return;

    const table =
      subjectType === 'TRANSACTION'
        ? { sql: `SELECT supplier_org_id AS org FROM receivable_transactions WHERE id = $1` }
        : subjectType === 'SUPPLIER_APPLICATION'
          ? { sql: `SELECT organization_id AS org FROM supplier_applications WHERE id = $1` }
          : null;

    if (!table) {
      throw AppException.validation(
        'subjectType must be TRANSACTION or SUPPLIER_APPLICATION.',
        { field: 'subjectType', value: subjectType },
      );
    }

    const row = await this.db.queryOne<{ org: string }>(table.sql, [subjectId]);
    // 404 rather than 403, for the same enumeration reason as everywhere else.
    if (!row || row.org !== ctx.organizationId) throw AppException.notFound('Subject');
  }

  // ------------------------------------------------------------------
  // Signed download
  // ------------------------------------------------------------------

  async createDownloadUrl(
    id: string,
    ctx: ActorContext,
  ): Promise<{ url: string; expiresAt: string }> {
    // Authorization FIRST, then the URL. The order is the requirement:
    // "issued only after a server-side authorization check".
    const document = await this.requireReadable(id, ctx);

    if (!document.storage_path) {
      throw AppException.notFound('Document');
    }
    const signed = await this.storage.createSignedDownload(document.storage_path);
    return { url: signed.signedUrl, expiresAt: signed.expiresAt.toISOString() };
  }

  // ------------------------------------------------------------------
  // Extraction retrieval (ZM-DOC-006)
  // ------------------------------------------------------------------

  /**
   * The contract's `Extraction` shape.
   *
   * `mismatches` carries three columns where they exist: what OCR read,
   * what the QR said, and what the supplier confirmed. The supplier's value
   * is joined in from the invoice rather than stored on the extraction, so
   * a correction can never overwrite the machine reading — they live in
   * different tables and only meet here, on the way out (ZM-DOC-006).
   */
  async getExtraction(id: string, ctx: ActorContext): Promise<Record<string, unknown>> {
    const authorized = await this.requireReadable(id, ctx);
    // First read of an uploaded document is what triggers hashing and OCR.
    const document = await this.ensureFinalized(authorized);
    const rows = await this.latestExtractions(document.id);

    const ocr = rows.find((r) => r.extraction_kind === 'OCR');
    const qr = rows.find((r) => r.extraction_kind === 'QR');
    const userValues = await this.supplierEnteredValues(document);

    return {
      documentId: document.id,
      ocr: {
        rawOutput: ocr?.raw_output ?? {},
        extractedFields: ocr?.extracted_fields ?? {},
        confidence: ocr?.confidence ? Number(ocr.confidence) : 0,
      },
      qr: {
        parsed: qr?.succeeded ?? false,
        extractedFields: qr?.extracted_fields ?? {},
        // failure_reason carries the status when the parse did not succeed;
        // a successful parse is VALID.
        validationStatus: qr?.succeeded ? 'VALID' : (qr?.failure_reason ?? 'UNAVAILABLE'),
      },
      mismatches: buildMismatches(
        ocr?.extracted_fields ?? {},
        qr?.extracted_fields ?? {},
        userValues,
      ),
    };
  }

  async latestExtractions(documentId: string): Promise<ExtractionRow[]> {
    const { rows } = await this.db.query<ExtractionRow>(
      `SELECT DISTINCT ON (extraction_kind)
              id, document_id, extraction_kind, raw_output, extracted_fields,
              confidence::text, engine_version, succeeded, failure_reason, created_at
         FROM document_extractions
        WHERE document_id = $1
        ORDER BY extraction_kind, created_at DESC`,
      [documentId],
    );
    return rows;
  }

  /**
   * What the supplier actually confirmed, for the third mismatch column.
   *
   * Read from the invoice attached to the same transaction. Absent before
   * the supplier fills the wizard in, which is the normal case at upload
   * time — the comparison then has two columns rather than three.
   */
  private async supplierEnteredValues(document: DocumentRow): Promise<Record<string, string>> {
    if (document.subject_type !== 'TRANSACTION' || !document.subject_id) return {};

    const invoice = await this.db.queryOne<{
      invoice_number: string;
      einvoice_identifier: string;
      issue_date: string;
      due_date: string;
      subtotal_amount: string;
      tax_amount: string;
      face_value: string;
    }>(
      `SELECT invoice_number, einvoice_identifier, issue_date::text, due_date::text,
              subtotal_amount::text, tax_amount::text, face_value::text
         FROM invoices WHERE transaction_id = $1`,
      [document.subject_id],
    );
    if (!invoice) return {};

    return {
      invoiceNumber: invoice.invoice_number,
      einvoiceIdentifier: invoice.einvoice_identifier,
      issueDate: invoice.issue_date,
      dueDate: invoice.due_date,
      subtotalAmount: invoice.subtotal_amount,
      taxAmount: invoice.tax_amount,
      faceValue: invoice.face_value,
    };
  }

  /** Documents attached to a subject, for the transaction detail view. */
  async listForSubject(subjectType: string, subjectId: string): Promise<DocumentRow[]> {
    const { rows } = await this.db.query<DocumentRow>(
      `SELECT id, owner_org_id, document_type, storage_path, file_name, mime_type,
              size_bytes::text, file_hash, subject_type, subject_id, uploaded_by, uploaded_at
         FROM documents
        WHERE subject_type = $1 AND subject_id = $2
        ORDER BY uploaded_at`,
      [subjectType, subjectId],
    );
    return rows;
  }

  /** Attach an already-created document to a transaction. */
  async attachToTransaction(documentId: string, transactionId: string): Promise<void> {
    await this.db.query(
      `UPDATE documents SET subject_type = 'TRANSACTION', subject_id = $2 WHERE id = $1`,
      [documentId, transactionId],
    );
  }

  /**
   * File-integrity re-check: does the stored object still hash to what was
   * recorded at upload?
   *
   * Returns null when the object is missing, which is a different finding
   * from a hash that changed and is reported as such by the verification
   * pipeline.
   */
  async verifyStoredHash(document: DocumentRow): Promise<{ matches: boolean; actual: string } | null> {
    const bytes = await this.storage.download(document.storage_path);
    if (!bytes) return null;
    const actual = createHash('sha256').update(bytes).digest('hex');
    return { matches: actual === document.file_hash, actual };
  }
}

/**
 * Build the three-column comparison the contract's `Extraction.mismatches`
 * declares.
 *
 * A field is reported only when at least two sources supplied it and they
 * disagree. A value only one source produced is not a mismatch — it is one
 * reading being more complete than another, and reporting it as a conflict
 * would bury the real conflicts.
 */
export function buildMismatches(
  ocrFields: Record<string, string>,
  qrFields: Record<string, string>,
  userFields: Record<string, string>,
): { field: string; ocrValue?: string; qrValue?: string; userValue?: string }[] {
  const keys = new Set([...Object.keys(ocrFields), ...Object.keys(qrFields), ...Object.keys(userFields)]);
  const out: { field: string; ocrValue?: string; qrValue?: string; userValue?: string }[] = [];

  for (const field of [...keys].sort()) {
    const values = [ocrFields[field], qrFields[field], userFields[field]].filter(
      (v): v is string => v !== undefined && v !== '',
    );
    if (values.length < 2) continue;
    if (new Set(values).size === 1) continue;

    out.push({
      field,
      ...(ocrFields[field] !== undefined ? { ocrValue: ocrFields[field] } : {}),
      ...(qrFields[field] !== undefined ? { qrValue: qrFields[field] } : {}),
      ...(userFields[field] !== undefined ? { userValue: userFields[field] } : {}),
    });
  }
  return out;
}
