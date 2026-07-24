"use client";

import { Suspense, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

// useSearchParams() requires a Suspense boundary at build time, or
// prerendering the page fails (missing-suspense-with-csr-bailout).
export default function Page() {
  return (
    <Suspense>
      <VerifyEmailPage />
    </Suspense>
  );
}

function VerifyEmailPage() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const email = searchParams.get("email") ?? "";
  const [resending, setResending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  // The emailed code is Supabase's own single-use signup token ({{ .Token }}
  // in the template) — verifyOtp validates and consumes it server-side at
  // Supabase and establishes the session, same guarantee as the link form.
  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setVerifying(true);
    setError(null);
    setSent(false);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      type: "signup",
      email,
      token: code.trim(),
    });
    setVerifying(false);
    if (verifyError) {
      setError(t("auth.otpInvalid"));
      return;
    }
    router.replace(`/${locale}`);
  }

  async function resend() {
    setResending(true);
    setError(null);
    setSent(false);
    // The error must surface: Supabase's built-in mailer rate-limits hard
    // (a handful of emails per hour), and an already-confirmed address is
    // refused too. Swallowing those showed a green ✓ over a send that never
    // happened — "resend isn't working" with no way to see why.
    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email,
      // Same destination as signup: the emailed activation link must land on
      // the confirm route that validates the single-use token.
      options: { emailRedirectTo: `${window.location.origin}/${locale}/confirm` },
    });
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
      <form onSubmit={submitCode} className="flex flex-col gap-4 text-start" noValidate>
        <Input
          label={t("auth.otpLabel")}
          type="text"
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <Button type="submit" loading={verifying} disabled={!code.trim()}>
          {t("auth.otpSubmit")}
        </Button>
      </form>
      <Button variant="secondary" loading={resending} onClick={resend}>
        {t("auth.resendLink")}
      </Button>
      {sent && <p className="text-xs text-(--color-success)">✓ {t("auth.resendSent")}</p>}
      {error && <p className="text-xs text-(--color-danger)">{error}</p>}
      <Button variant="ghost" onClick={() => router.push(`/${locale}/login`)}>
        {t("auth.loginButton")}
      </Button>
    </div>
  );
}
