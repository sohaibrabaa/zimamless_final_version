"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { DevPersonaPicker } from "@/components/dev/DevPersonaPicker";

export default function LoginPage() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) {
      setError(t("auth.invalidCredentials"));
      return;
    }
    router.push(`/${locale}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold">{t("auth.loginTitle")}</h1>
        <p className="text-sm text-(--color-muted)">{t("auth.loginSubtitle")}</p>
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
          label={t("auth.password")}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" loading={loading} className="mt-2">
          {t("auth.loginButton")}
        </Button>
      </form>
      <p className="text-center text-sm text-(--color-muted)">
        {t("auth.noAccount")}{" "}
        <Link href={`/${locale}/register`} className="font-medium text-(--color-primary)">
          {t("auth.registerButton")}
        </Link>
      </p>
      <DevPersonaPicker />
    </div>
  );
}
