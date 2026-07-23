"use client";

import { useState } from "react";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ApiError } from "@/lib/api/client";
import { isWellFormedOtp, normalizeOtpInput, OTP_LENGTH } from "@/lib/funding/funding-domain";
import { OtpRejected, useFundingConfirmation } from "@/lib/funding/useFunding";

/**
 * The supplier's half of INV-10.
 *
 * The failure message is one sentence, and it is the same sentence whatever
 * went wrong. The server refuses to distinguish wrong from expired from
 * already-used (`ZM-FND-009`), and a screen that inferred the difference —
 * from a status code, a timing difference, or a second request that probes
 * for expiry — would give back precisely the oracle the server withheld. The
 * only detail rendered is `attemptsRemaining`, which the server does disclose.
 *
 * The code is held in component state and cleared on every outcome, success
 * or failure: a confirmed code has no further use, and a rejected one should
 * not sit in the field inviting the same attempt again.
 */
export function ConfirmFundingForm({
  transactionId,
  onConfirmed,
}: {
  transactionId: string;
  onConfirmed: (state: string | undefined) => void;
}) {
  const t = useTranslations();
  const { confirm } = useFundingConfirmation();

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; attemptsRemaining: number | null } | null>(null);

  const ready = isWellFormedOtp(code);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;

    setBusy(true);
    setFailure(null);
    try {
      const result = await confirm(transactionId, code);
      setCode("");
      onConfirmed(result.transactionState);
    } catch (err) {
      setCode("");
      if (err instanceof OtpRejected) {
        // One message. Not a switch on why.
        setFailure({
          message: t("funding.confirm.rejected"),
          attemptsRemaining: err.attemptsRemaining,
        });
      } else {
        setFailure({
          message: err instanceof ApiError ? err.message : t("common.unknownError"),
          attemptsRemaining: null,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-sm">
      <p className="mb-3 text-sm text-(--color-muted)">{t("funding.confirm.instructions")}</p>

      <Input
        label={t("funding.confirm.codeLabel")}
        hint={t("funding.confirm.codeHint")}
        // `inputMode` rather than `type="number"`: a numeric input strips the
        // leading zero, and "004321" is a real code.
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={OTP_LENGTH}
        className="zm-ltr-embed font-mono text-lg tracking-[0.3em] tabular-nums"
        value={code}
        error={failure?.message}
        onChange={(e) => setCode(normalizeOtpInput(e.target.value))}
        required
      />

      {failure?.attemptsRemaining !== null && failure !== null && (
        <p className="mt-2 text-xs text-(--color-muted)">
          {t("funding.confirm.attemptsRemaining", { count: String(failure.attemptsRemaining) })}
        </p>
      )}

      <Button type="submit" className="mt-4" disabled={!ready} loading={busy}>
        {t("funding.confirm.submit")}
      </Button>
    </form>
  );
}
