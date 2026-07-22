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

  async function resend() {
    setResending(true);
    await supabase.auth.resend({ type: "signup", email });
    setResending(false);
    setSent(true);
  }

  return (
    <div className="flex flex-col gap-4 text-center">
      <h1 className="text-lg font-semibold">{t("auth.verifyEmailTitle")}</h1>
      <p className="text-sm text-(--color-muted)">{t("auth.verifyEmailBody", { email })}</p>
      <Button variant="secondary" loading={resending} onClick={resend}>
        {t("auth.resendCode")}
      </Button>
      {sent && <p className="text-xs text-(--color-success)">✓</p>}
      <Button variant="ghost" onClick={() => router.push(`/${locale}/verify-phone`)}>
        {t("common.next")}
      </Button>
    </div>
  );
}
