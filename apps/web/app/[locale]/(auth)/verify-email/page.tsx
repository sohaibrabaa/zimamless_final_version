"use client";

import { useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";

export default function VerifyEmailPage() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const [resending, setResending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setResending(true);
    setError(null);
    setSent(false);
    // The error must surface: Supabase's built-in mailer rate-limits hard
    // (a handful of emails per hour), and an already-confirmed address is
    // refused too. Swallowing those showed a green ✓ over a send that never
    // happened — "resend isn't working" with no way to see why.
    const { error: resendError } = await supabase.auth.resend({ type: "signup", email });
    setResending(false);
    if (resendError) {
      setError(
        resendError.message.toLowerCase().includes("rate limit")
          ? t("auth.resendRateLimited")
          : resendError.message
      );
      return;
    }
    setSent(true);
  }

  return (
    <div className="flex flex-col gap-4 text-center">
      <h1 className="text-lg font-semibold">{t("auth.verifyEmailTitle")}</h1>
      <p className="text-sm text-(--color-muted)">{t("auth.verifyEmailBody", { email })}</p>
      <p className="text-xs text-(--color-muted)">{t("auth.verifyEmailHint")}</p>
      <Button variant="secondary" loading={resending} onClick={resend}>
        {t("auth.resendCode")}
      </Button>
      {sent && <p className="text-xs text-(--color-success)">✓ {t("auth.resendSent")}</p>}
      {error && <p className="text-xs text-(--color-danger)">{error}</p>}
      <Button variant="ghost" onClick={() => router.push(`/${locale}/login`)}>
        {t("auth.loginButton")}
      </Button>
    </div>
  );
}
