"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export default function VerifyPhonePage() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const phone = user?.phone;
    if (!phone) {
      setError("No phone number on file.");
      setLoading(false);
      return;
    }
    const { error: verifyError } = await supabase.auth.verifyOtp({ phone, token: code, type: "sms" });
    setLoading(false);
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    router.push(`/${locale}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 text-center" noValidate>
      <h1 className="text-lg font-semibold">{t("auth.verifyPhoneTitle")}</h1>
      <p className="text-sm text-(--color-muted)">{t("auth.verifyPhoneBody", { phone: "" })}</p>
      <Input
        label={t("auth.verifyPhoneTitle")}
        inputMode="numeric"
        dir="ltr"
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
        error={error ?? undefined}
      />
      <Button type="submit" loading={loading}>
        {t("common.submit")}
      </Button>
    </form>
  );
}
