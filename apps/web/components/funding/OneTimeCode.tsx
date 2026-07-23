"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";

/**
 * The one place in the entire frontend where an OTP in plaintext exists.
 *
 * The standing rule is that the code lives in exactly two places: the single
 * API response that returns it, and this component's memory. Everything about
 * this file follows from that:
 *
 *   - it is held in `useState`, never lifted to a store, a context, a ref
 *     that outlives the screen, or a URL;
 *   - it is never written to `localStorage` or `sessionStorage` — that would
 *     put a live credential on disk, where it outlives the session that
 *     needed it and survives into whoever uses the machine next;
 *   - it is cleared on unmount, so navigating away disposes of it rather than
 *     leaving it in a detached component React may hold briefly;
 *   - it is never logged, and never placed in an element with a `title` or
 *     `aria-label` that would put it somewhere unexpected.
 *
 * The dismiss button is not decoration. A bank operator reads this code down
 * a phone line to a supplier, and the screen is often visible to other people
 * in the branch; being able to remove it the moment it has been read is the
 * whole point of showing it once.
 */
export function OneTimeCode({
  code,
  expiresAt,
  resendsRemaining,
  onDismiss,
}: {
  code: string;
  expiresAt: string;
  resendsRemaining: number;
  onDismiss: () => void;
}) {
  const t = useTranslations();
  const [revealed, setRevealed] = useState(true);

  useEffect(() => {
    // Belt and braces: whatever else happens, this component going away
    // means the code goes away with it.
    return () => setRevealed(false);
  }, []);

  const expires = new Date(expiresAt);

  return (
    <div
      className="mt-4 rounded-lg border border-(--color-warning) bg-(--color-warning-bg) p-4"
      // Announced to a screen reader as one unit, because the code and the
      // "shown once" warning are meaningless apart.
      role="status"
    >
      <p className="text-sm font-semibold text-(--color-warning)">{t("funding.otp.shownOnce")}</p>

      {revealed ? (
        <p
          className="zm-ltr-embed mt-3 font-mono text-3xl tracking-[0.35em] tabular-nums"
          // The digits are read one at a time; as a single token a screen
          // reader says "twelve thousand three hundred forty-five".
          aria-label={code.split("").join(" ")}
        >
          {code}
        </p>
      ) : (
        <p className="mt-3 text-sm text-(--color-muted)">{t("funding.otp.dismissed")}</p>
      )}

      <p className="mt-3 text-xs text-(--color-muted)">
        {t("funding.otp.expiresAt", { time: expires.toISOString().slice(11, 16) })} ·{" "}
        {t("funding.otp.resendsRemaining", { count: String(resendsRemaining) })}
      </p>
      <p className="mt-2 text-xs text-(--color-muted)">{t("funding.otp.notASignature")}</p>

      {revealed && (
        <Button type="button" variant="secondary" className="mt-3" onClick={onDismiss}>
          {t("funding.otp.dismiss")}
        </Button>
      )}
    </div>
  );
}
