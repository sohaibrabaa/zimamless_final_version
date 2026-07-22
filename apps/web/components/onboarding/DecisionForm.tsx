"use client";

import { useState } from "react";
import { apiClient, ApiError } from "@/lib/api/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/Toast";
import {
  DECISION_OUTCOMES,
  reasonCodesFor,
  type DecisionOutcome,
} from "@/lib/onboarding/reason-codes";
import { isDecided } from "@/lib/onboarding/status";

/**
 * Reviewer decision form — approve / conditional / information-required /
 * reject with a structured reason code (§5.7, ZM-SON-013).
 *
 * The reason-code picker is scoped to the chosen outcome so a rejection code
 * can never be filed against an approval. The catalogue itself is provisional
 * (see Q-02) and lives in lib/onboarding/reason-codes.ts.
 *
 * There is no "quick approve" shortcut: the decision is deliberately two
 * explicit choices plus a confirm, because it is what flips an organization to
 * ACTIVE.
 */
export function DecisionForm({
  applicationId,
  currentStatus,
  onDecided,
}: {
  applicationId: string;
  currentStatus: string | undefined;
  onDecided: () => void;
}) {
  const t = useTranslations();
  const { show } = useToast();

  const [outcome, setOutcome] = useState<DecisionOutcome | "">("");
  const [reasonCode, setReasonCode] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyDecided = isDecided(currentStatus);
  const availableReasons = outcome ? reasonCodesFor(outcome) : [];
  // Approval is the one outcome that legitimately carries no reason code.
  const reasonRequired = outcome !== "" && outcome !== "APPROVED";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!outcome) return;
    setBusy(true);
    setError(null);
    try {
      const { error: apiError } = await apiClient.POST(
        "/onboarding/applications/{id}/decide",
        {
          params: { path: { id: applicationId } },
          body: {
            decision: outcome,
            ...(reasonCode ? { reasonCode } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          },
        }
      );
      if (apiError) throw apiError;
      show({ title: t("onboarding.decision.recorded"), tone: "success" });
      setOutcome("");
      setReasonCode("");
      setNotes("");
      onDecided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  if (alreadyDecided) {
    return (
      <p className="rounded-lg border border-(--color-border) px-4 py-3 text-sm text-(--color-muted)">
        {t("onboarding.decision.alreadyDecided")}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-md rounded-lg border border-(--color-border) p-4">
      <h2 className="text-sm font-semibold">{t("onboarding.decision.title")}</h2>
      <div className="mt-3 flex flex-col gap-4">
        <Select
          label={t("onboarding.decision.outcome")}
          value={outcome}
          onChange={(e) => {
            setOutcome(e.target.value as DecisionOutcome | "");
            setReasonCode("");
          }}
          placeholder={t("onboarding.decision.choose")}
          options={DECISION_OUTCOMES.map((o) => ({
            value: o,
            label: t(`onboarding.decision.option.${o}`),
          }))}
          required
        />

        {outcome && (
          <p className="rounded-md bg-(--color-neutral-bg) px-3 py-2 text-xs text-(--color-neutral-fg)">
            {t(`onboarding.decision.effect.${outcome}`)}
          </p>
        )}

        {reasonRequired && (
          <Select
            label={t("onboarding.decision.reasonCode")}
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
            placeholder={t("onboarding.decision.choose")}
            options={availableReasons.map((r) => ({ value: r.code, label: t(r.labelKey) }))}
            required
          />
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="decision-notes" className="text-sm font-medium text-(--color-fg)">
            {t("onboarding.decision.notes")}
          </label>
          <textarea
            id="decision-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="rounded-md border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm text-(--color-fg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary)"
          />
          <p className="text-xs text-(--color-muted)">
            {outcome === "INFORMATION_REQUIRED"
              ? t("onboarding.decision.notesBecomeRequest")
              : t("onboarding.decision.notesHint")}
          </p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-(--color-danger)">
            {error}
          </p>
        )}

        <Button
          type="submit"
          loading={busy}
          disabled={!outcome || (reasonRequired && !reasonCode)}
          className="self-start"
        >
          {t("onboarding.decision.submit")}
        </Button>
      </div>
    </form>
  );
}
