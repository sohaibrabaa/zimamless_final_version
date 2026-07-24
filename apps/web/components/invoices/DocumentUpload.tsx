"use client";

import { useRef, useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import {
  ACCEPTED_MIME_TYPES,
  fileRejectionKey,
  rejectFile,
  type DocumentType,
} from "@/lib/invoices/documents";

export interface UploadedDocument {
  documentId: string;
  documentType: DocumentType;
  fileName: string;
}

/** Mock mode never PUTs bytes — the mock uploadUrl is a host that doesn't exist. */
const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

/**
 * A single document upload, driven by `POST /documents/upload-url`.
 *
 * The two-step shape (ask the API for a signed URL, then PUT the bytes to it)
 * is ZM-DOC-004: the URL is short-lived and is only issued after a server-side
 * authorization check, so the browser never holds a durable storage
 * credential. Against MSW the returned URL is a mock host that no request is
 * actually sent to — the byte upload is deliberately skipped rather than
 * faked, because a mock that "succeeded" at storing a file would hide the one
 * thing the live swap has to prove.
 */
export function DocumentUpload({
  documentType,
  label,
  description,
  transactionId,
  uploaded,
  onUploaded,
  onRemoved,
}: {
  documentType: DocumentType;
  label: string;
  description?: string;
  transactionId: string;
  uploaded?: UploadedDocument;
  onUploaded: (doc: UploadedDocument) => void;
  onRemoved?: () => void;
}) {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    const rejection = rejectFile({ type: file.type, size: file.size });
    if (rejection) {
      setError(t(fileRejectionKey(rejection)));
      return;
    }

    setBusy(true);
    try {
      const { data, error: apiError } = await apiClient.POST("/documents/upload-url", {
        body: {
          documentType,
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          subjectType: "TRANSACTION",
          subjectId: transactionId,
        },
      });
      if (apiError) throw apiError;
      if (!data?.documentId) throw new Error("No documentId returned");

      // The actual byte upload to the signed URL. Without this PUT the
      // document exists only as metadata: storage stays empty, the hash is
      // never computed, and OCR/QR extraction has nothing to read — the
      // wizard then shows an "uploaded" file with no suggestions. Skipped
      // under MSW, where the mock uploadUrl is a host no request can reach.
      if (!MOCKING_ENABLED) {
        if (!data.uploadUrl) throw new Error("No uploadUrl returned");
        const put = await fetch(data.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type },
          body: file,
        });
        if (!put.ok) {
          const detail = await put.text().catch(() => "");
          console.error(
            `[DocumentUpload] byte PUT to storage failed: ${put.status} ${put.statusText}`,
            detail.slice(0, 500)
          );
          setError(t("invoices.documents.uploadFailed"));
          return;
        }
        console.debug(
          `[DocumentUpload] uploaded ${file.name} (${file.size} bytes) as document ${data.documentId}`
        );
      }

      onUploaded({ documentId: data.documentId, documentType, fileName: file.name });
    } catch (err) {
      console.error("[DocumentUpload] upload failed:", err);
      setError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="rounded-lg border border-(--color-border) px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {description && <p className="mt-0.5 text-xs text-(--color-muted)">{description}</p>}
          {uploaded && (
            <p className="zm-ltr-embed mt-1 text-xs text-(--color-muted)">{uploaded.fileName}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {uploaded && onRemoved && (
            <Button type="button" variant="ghost" size="sm" onClick={onRemoved}>
              {t("invoices.documents.remove")}
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => inputRef.current?.click()}
          >
            {uploaded ? t("invoices.documents.replace") : t("invoices.documents.choose")}
          </Button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        accept={ACCEPTED_MIME_TYPES.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      {error && (
        <p role="alert" className="mt-2 text-xs text-(--color-danger)">
          {error}
        </p>
      )}
    </div>
  );
}
