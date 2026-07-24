"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

// Establishment number, licence number, and the rest of the supplier profile
// are collected in the onboarding wizard (Phase 2, POST /onboarding/register
// — v3.1.0 D-04), not here. This screen only creates the Supabase account
// (PA-04): phone, email, password.
export default function RegisterPage() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // The phone travels as profile metadata only — NOT as a Supabase auth
    // factor. No SMS provider is configured, so a top-level `phone` would
    // enroll a verification channel that can never deliver a code, stranding
    // every registration behind an unpassable step. Email is the single
    // verification factor.
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { phone } },
    });
    setLoading(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    // When email confirmation is disabled on the project, signUp already
    // returns a live session — go straight in rather than telling the user
    // to wait for an email that will never matter.
    if (data.session) {
      router.push(`/${locale}`);
      return;
    }
    router.push(`/${locale}/verify-email?email=${encodeURIComponent(email)}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">{t("auth.registerTitle")}</h1>
        <p className="text-sm text-(--color-muted)">{t("auth.registerSubtitle")}</p>
      </div>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Input
          label={t("auth.email")}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label={t("auth.phone")}
          type="tel"
          dir="ltr"
          autoComplete="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Input
          label={t("auth.password")}
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" loading={loading} className="mt-2">
          {t("auth.registerButton")}
        </Button>
      </form>
      <p className="text-center text-sm text-(--color-muted)">
        {t("auth.haveAccount")}{" "}
        <Link href={`/${locale}/login`} className="font-medium text-(--color-secondary)">
          {t("auth.loginButton")}
        </Link>
      </p>
    </div>
  );
}
