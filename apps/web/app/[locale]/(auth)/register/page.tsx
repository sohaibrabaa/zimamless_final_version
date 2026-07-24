"use client";

import { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

// The dictionary layer returns strings only, so the terms live as numbered
// keys rather than an array; rendered in this order in the modal.
const TERMS_KEYS = [
  "auth.termsPlaceholder",
  "auth.terms1",
  "auth.terms2",
  "auth.terms3",
  "auth.terms4",
  "auth.terms5",
  "auth.terms6",
  "auth.terms7",
  "auth.terms8",
  "auth.terms9",
];

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
  const [agreed, setAgreed] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // The button is disabled until the box is ticked; this is the safety net
    // for submits that bypass it (e.g. Enter in a field).
    if (!agreed) {
      setError(t("auth.termsRequired"));
      return;
    }
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
      options: {
        data: { phone },
        // The activation email carries a single-use Supabase confirmation
        // link; this sends the user back to our confirm route, which
        // validates the token and establishes the session.
        emailRedirectTo: `${window.location.origin}/${locale}/confirm`,
      },
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
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span className="text-sm text-(--color-muted)">
            {t("auth.termsCheckboxLabel")}
            <button
              type="button"
              className="font-medium text-(--color-secondary) underline underline-offset-2"
              onClick={(e) => {
                // Inside a <label>, a plain click would also toggle the
                // checkbox — reading the terms must not count as agreeing.
                e.preventDefault();
                setTermsOpen(true);
              }}
            >
              {t("auth.termsLinkText")}
            </button>
          </span>
        </label>
        <Button type="submit" loading={loading} disabled={!agreed} className="mt-2">
          {t("auth.registerButton")}
        </Button>
      </form>
      <Modal
        open={termsOpen}
        onClose={() => setTermsOpen(false)}
        title={t("auth.termsModalTitle")}
        footer={
          <Button type="button" variant="secondary" onClick={() => setTermsOpen(false)}>
            {t("common.close")}
          </Button>
        }
      >
        <div className="max-h-[60vh] space-y-3 overflow-y-auto text-sm text-(--color-fg)">
          {TERMS_KEYS.map((key) => (
            <p key={key}>{t(key)}</p>
          ))}
        </div>
      </Modal>
      <p className="text-center text-sm text-(--color-muted)">
        {t("auth.haveAccount")}{" "}
        <Link href={`/${locale}/login`} className="font-medium text-(--color-secondary)">
          {t("auth.loginButton")}
        </Link>
      </p>
    </div>
  );
}
