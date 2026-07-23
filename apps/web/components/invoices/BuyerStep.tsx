"use client";

import { useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/StatePanels";
import {
  buyerStatusExplanationKey,
  buyerStatusLabelKey,
  buyerStatusTone,
  buyerSelectability,
  contactIsComplete,
  initialBuyerSelection,
  isBuyerBlocked,
  type Buyer,
  type BuyerCandidate,
  type BuyerContactInput,
} from "@/lib/invoices/buyer-rules";

/**
 * Step 1 — Buyer.
 *
 * The rule this screen exists to honour is ZM-BUY-009: the platform MUST NOT
 * auto-select a buyer on name similarity, *under any circumstances*. So:
 *
 *   - The selection starts null and stays null until the supplier clicks
 *     (`initialBuyerSelection` is a function returning null rather than an
 *     omitted line, so the rule is a thing a test can hold on to).
 *   - A single, exact, 100%-name-match candidate is rendered identically to
 *     any other — no highlight, no "best match", no pre-checked radio.
 *   - Candidates are rendered in the order the API returned them. No client
 *     sort, because any sort is a ranking and a ranking is a recommendation.
 *
 * Blocked buyers (SUSPENDED / STRUCK_OFF) are shown, not hidden, with the
 * reason stated as a fact about the registry record — never as an accusation
 * against the supplier who is trying to invoice them.
 */
export function BuyerStep({
  selectedBuyer,
  contact,
  onChange,
}: {
  selectedBuyer: Buyer | null;
  contact: Partial<BuyerContactInput>;
  onChange: (next: { buyer: Buyer | null; contact: Partial<BuyerContactInput> }) => void;
}) {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<BuyerCandidate[] | null>(null);
  const [requiresManualReview, setRequiresManualReview] = useState(false);
  const [chosen, setChosen] = useState<BuyerCandidate | null>(null);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    setError(null);
    setSearching(true);
    setChosen(null);
    try {
      const { data, error: apiError } = await apiClient.GET("/buyers/search", {
        params: { query: { q: query.trim() } },
      });
      if (apiError) throw apiError;
      const returned = data?.candidates ?? [];
      setCandidates(returned);
      setRequiresManualReview(data?.requiresManualReview === true);
      // Never a pre-selection, not even when exactly one candidate came back
      // at a perfect name match. That case is the one ZM-BUY-009 names.
      setChosen(initialBuyerSelection(returned));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.unknownError"));
      setCandidates(null);
    } finally {
      setSearching(false);
    }
  }

  async function handleConfirm() {
    if (!chosen?.nationalEstablishmentNumber) return;
    setError(null);
    setResolving(true);
    try {
      const { data, error: apiError } = await apiClient.POST("/buyers/resolve", {
        body: {
          nationalEstablishmentNumber: chosen.nationalEstablishmentNumber,
          // The supplier clicked a specific row and then this button. That is
          // the explicit confirmation the contract requires.
          confirmedByUser: true,
          ...(contactIsComplete(contact)
            ? { contact: contact as BuyerContactInput }
            : {}),
        },
      });
      if (apiError) throw apiError;
      onChange({ buyer: (data as Buyer) ?? null, contact });
    } catch (err) {
      if (err instanceof ApiError && err.code === "BUYER_BLOCKED") {
        const status = (err.details as { registryStatus?: string } | undefined)?.registryStatus;
        const key = buyerStatusExplanationKey(status);
        setError(key ? t(key) : err.message);
      } else {
        setError(err instanceof ApiError ? err.message : t("common.unknownError"));
      }
    } finally {
      setResolving(false);
    }
  }

  if (selectedBuyer) {
    return (
      <section aria-labelledby="buyer-step-heading">
        <h2 id="buyer-step-heading" className="text-base font-semibold">
          {t("invoices.wizard.step.buyer")}
        </h2>
        <div className="mt-4 rounded-lg border border-(--color-border) px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{selectedBuyer.legalCompanyName}</span>
            <Badge tone={buyerStatusTone(selectedBuyer.registryStatus)}>
              {t(buyerStatusLabelKey(selectedBuyer.registryStatus))}
            </Badge>
          </div>
          <p className="zm-ltr-embed mt-1 text-xs text-(--color-muted)">
            {selectedBuyer.nationalEstablishmentNumber}
          </p>
          {buyerSelectability(selectedBuyer.registryStatus) === "manualReview" && (
            <p className="mt-2 text-sm text-(--color-muted)">
              {t(buyerStatusExplanationKey(selectedBuyer.registryStatus) ?? "invoices.buyer.review.UNKNOWN")}
            </p>
          )}
        </div>

        <ContactFields
          contact={contact}
          onChange={(next) => onChange({ buyer: selectedBuyer, contact: next })}
        />

        <Button
          type="button"
          variant="secondary"
          className="mt-4"
          onClick={() => {
            setChosen(null);
            onChange({ buyer: null, contact });
          }}
        >
          {t("invoices.buyer.changeBuyer")}
        </Button>
      </section>
    );
  }

  return (
    <section aria-labelledby="buyer-step-heading">
      <h2 id="buyer-step-heading" className="text-base font-semibold">
        {t("invoices.wizard.step.buyer")}
      </h2>
      <p className="mt-1 text-sm text-(--color-muted)">{t("invoices.buyer.intro")}</p>

      <div className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <Input
            label={t("invoices.buyer.searchLabel")}
            hint={t("invoices.buyer.searchHint")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim().length >= 2) {
                e.preventDefault();
                void handleSearch();
              }
            }}
          />
        </div>
        <Button
          type="button"
          loading={searching}
          disabled={query.trim().length < 2}
          onClick={handleSearch}
        >
          {t("common.search")}
        </Button>
      </div>

      {requiresManualReview && candidates && candidates.length > 0 && (
        <p className="mt-3 rounded-md border border-(--color-border) px-3 py-2 text-sm text-(--color-muted)">
          {t("invoices.buyer.manualReviewNotice")}
        </p>
      )}

      {candidates?.length === 0 && (
        <div className="mt-4">
          <EmptyState title={t("invoices.buyer.noCandidates")} description={t("invoices.buyer.noCandidatesHint")} />
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {candidates.map((candidate) => {
            const blocked = isBuyerBlocked(candidate.registryStatus);
            const isChosen = chosen?.nationalEstablishmentNumber === candidate.nationalEstablishmentNumber;
            const explanation = buyerStatusExplanationKey(candidate.registryStatus);
            return (
              <li key={candidate.nationalEstablishmentNumber}>
                <label
                  className={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                    blocked
                      ? "border-(--color-border) opacity-70"
                      : isChosen
                        ? "border-(--color-primary)"
                        : "border-(--color-border) cursor-pointer"
                  }`}
                >
                  <input
                    type="radio"
                    name="buyer-candidate"
                    className="mt-1 h-4 w-4 shrink-0"
                    disabled={blocked}
                    checked={isChosen}
                    onChange={() => setChosen(candidate)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{candidate.legalCompanyName}</span>
                      <Badge tone={buyerStatusTone(candidate.registryStatus)}>
                        {t(buyerStatusLabelKey(candidate.registryStatus))}
                      </Badge>
                    </span>
                    <span className="zm-ltr-embed mt-0.5 block text-xs text-(--color-muted)">
                      {candidate.nationalEstablishmentNumber}
                    </span>
                    <span className="mt-0.5 block text-xs text-(--color-muted)">
                      {[candidate.companyType, candidate.governorate].filter(Boolean).join(" · ")}
                    </span>
                    {explanation && (
                      <span className="mt-1.5 block text-sm text-(--color-muted)">
                        {t(explanation)}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {chosen && (
        <>
          <ContactFields contact={contact} onChange={(next) => onChange({ buyer: null, contact: next })} />
          <Button
            type="button"
            className="mt-4"
            loading={resolving}
            disabled={!contactIsComplete(contact)}
            onClick={handleConfirm}
          >
            {t("invoices.buyer.confirmSelection")}
          </Button>
          {!contactIsComplete(contact) && (
            <p className="mt-2 text-xs text-(--color-muted)">{t("invoices.buyer.contactRequired")}</p>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-(--color-danger)">
          {error}
        </p>
      )}
    </section>
  );
}

function ContactFields({
  contact,
  onChange,
}: {
  contact: Partial<BuyerContactInput>;
  onChange: (next: Partial<BuyerContactInput>) => void;
}) {
  const t = useTranslations();
  return (
    <div className="mt-6 max-w-md">
      <h3 className="text-sm font-semibold">{t("invoices.buyer.contactTitle")}</h3>
      {/* ZM-BUY-011: this is explicitly supplier-provided data, not the
          buyer's official registry contact, and the copy has to say so —
          otherwise the field reads as something the registry vouched for. */}
      <p className="mt-1 mb-3 text-xs text-(--color-muted)">{t("invoices.buyer.contactNotice")}</p>
      <div className="flex flex-col gap-4">
        <Input
          label={t("invoices.buyer.contactName")}
          value={contact.contactName ?? ""}
          onChange={(e) => onChange({ ...contact, contactName: e.target.value })}
          required
        />
        <Input
          label={t("invoices.buyer.contactRole")}
          value={contact.contactRole ?? ""}
          onChange={(e) => onChange({ ...contact, contactRole: e.target.value })}
          required
        />
        <Input
          label={t("invoices.buyer.contactPhone")}
          value={contact.contactPhone ?? ""}
          onChange={(e) => onChange({ ...contact, contactPhone: e.target.value })}
          dir="ltr"
          required
        />
        <Input
          label={t("invoices.buyer.contactEmail")}
          type="email"
          value={contact.contactEmail ?? ""}
          onChange={(e) => onChange({ ...contact, contactEmail: e.target.value })}
          dir="ltr"
        />
      </div>
    </div>
  );
}
