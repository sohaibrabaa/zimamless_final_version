"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import {
  qrStatusExplanationKey,
  qrStatusLabelKey,
  qrStatusTone,
  type Extraction,
  type FieldComparison,
} from "@/lib/invoices/extraction";

/**
 * Extracted-vs-entered comparison (phase file, B step 2).
 *
 * The load-bearing sentence on this screen is the one saying that a correction
 * is **recorded alongside** the machine's reading and does not replace it
 * (ZM-DOC-006). Without it, a supplier who types over a pre-filled value
 * reasonably assumes they have erased what OCR read — and would then hesitate
 * to correct an error, which is the opposite of what the step is for. The copy
 * is a requirement, not decoration; it is asserted by a test for that reason.
 *
 * A mismatch is rendered as a difference to look at, never as a finding: no
 * red, no warning icon. The platform does not know which value is right, which
 * is precisely why it is asking.
 */
export function ExtractionComparison({
  extraction,
  comparisons,
}: {
  extraction: Extraction | null | undefined;
  comparisons: readonly FieldComparison[];
}) {
  const t = useTranslations();
  const qrStatus = extraction?.qr?.validationStatus;
  const qrExplanation = qrStatusExplanationKey(qrStatus);

  return (
    <div className="rounded-lg border border-(--color-border) p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("invoices.extraction.title")}</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-(--color-muted)">{t("invoices.extraction.qrLabel")}</span>
          <Badge tone={qrStatusTone(qrStatus)}>{t(qrStatusLabelKey(qrStatus))}</Badge>
        </div>
      </div>

      <p className="mt-2 text-xs text-(--color-muted)">{t("invoices.extraction.bothKeptNotice")}</p>

      {qrExplanation && (
        <p className="mt-2 rounded-md border border-(--color-border) px-3 py-2 text-sm text-(--color-muted)">
          {t(qrExplanation)}
        </p>
      )}

      {comparisons.length === 0 ? (
        <p className="mt-3 text-sm text-(--color-muted)">{t("invoices.extraction.noValues")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="text-xs text-(--color-muted)">
                <th scope="col" className="py-1.5 text-start font-medium">
                  {t("invoices.extraction.column.field")}
                </th>
                <th scope="col" className="py-1.5 text-start font-medium">
                  {t("invoices.extraction.column.ocr")}
                </th>
                <th scope="col" className="py-1.5 text-start font-medium">
                  {t("invoices.extraction.column.qr")}
                </th>
                <th scope="col" className="py-1.5 text-start font-medium">
                  {t("invoices.extraction.column.entered")}
                </th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((c) => (
                <tr key={c.field} className="border-t border-(--color-border)">
                  <td className="py-2 pe-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <span>{t(`invoices.field.${c.field}`)}</span>
                      {c.mismatch && (
                        // "Differs", not "wrong". Neutral tone, because the
                        // platform has no basis yet to say which is correct.
                        <Badge tone="info">{t("invoices.extraction.differs")}</Badge>
                      )}
                    </span>
                  </td>
                  <td className="zm-ltr-embed py-2 pe-3 text-(--color-muted)">{c.ocrValue ?? "—"}</td>
                  <td className="zm-ltr-embed py-2 pe-3 text-(--color-muted)">{c.qrValue ?? "—"}</td>
                  <td className="zm-ltr-embed py-2 font-medium">{c.userValue || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {typeof extraction?.ocr?.confidence === "number" && (
        <p className="mt-3 text-xs text-(--color-muted)">
          {t("invoices.extraction.confidence", {
            // Presentational only, and never money — a percentage of a
            // confidence score is the one number on these screens that is
            // legitimately a number.
            value: String(Math.round(extraction.ocr.confidence * 100)),
          })}
        </p>
      )}
    </div>
  );
}
