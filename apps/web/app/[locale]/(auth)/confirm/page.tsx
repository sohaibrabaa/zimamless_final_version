"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Button } from "@/components/ui/Button";

// useSearchParams() requires a Suspense boundary at build time, or
// prerendering the page fails (missing-suspense-with-csr-bailout).
export default function Page() {
  return (
    <Suspense>
      <ConfirmPage />
    </Suspense>
  );
}

/**
 * Landing point of the emailed activation link (PA-04: verification stays
 * client-side against Supabase Auth). Two arrival formats, both backed by
 * Supabase's own single-use confirmation token — no custom tokens, no API
 * involvement; the NestJS API only ever sees the resulting JWT:
 *
 * 1. `?token_hash=…&type=signup` (custom-SMTP template): verifyOtp validates
 *    and consumes the token at Supabase and establishes the session here.
 * 2. Default `{{ .ConfirmationURL }}` template (no custom SMTP — templates
 *    aren't editable on the built-in mailer): Supabase verifies the token on
 *    its side first, then redirects here with session tokens (or an error)
 *    in the URL fragment; the client consumes them in the background
 *    (detectSessionInUrl), so we wait for the session to materialize.
 */
function ConfirmPage() {
  const t = useTranslations();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const searchParams = useSearchParams();
  const [failed, setFailed] = useState(false);
  // React StrictMode mounts effects twice in dev; the token is single-use,
  // so a second verifyOtp with the same token would report failure right
  // after the first one succeeded. Run exactly once.
  const started = useRef(false);

  const email = searchParams.get("email") ?? "";
  const tokenHash = searchParams.get("token_hash");
  // Supabase appends the type it minted the token for; a signup
  // confirmation is the only flow that points here today.
  const type = (searchParams.get("type") ?? "signup") as EmailOtpType;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let active = true;
    const dest = `/${locale}`;

    const run = async () => {
      if (tokenHash) {
        const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
        if (!active) return;
        if (error) {
          setFailed(true);
          return;
        }
        router.replace(dest);
        return;
      }

      // Default-template arrival: the session may already be live (the
      // client consumed the fragment tokens before we mounted) …
      const { data: initial } = await supabase.auth.getSession();
      if (!active) return;
      if (initial.session) {
        router.replace(dest);
        return;
      }

      // … or Supabase reported failure in the fragment (expired/used link),
      // or there is nothing to wait for at all (page opened directly).
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const hasError = Boolean(fragment.get("error") || fragment.get("error_code"));
      if (hasError || !window.location.hash) {
        setFailed(true);
        return;
      }

      // Fragment tokens present: poll briefly while the client stores them.
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const { data } = await supabase.auth.getSession();
        if (!active) return;
        if (data.session) {
          router.replace(dest);
          return;
        }
      }
      setFailed(true);
    };

    void run();
    return () => {
      active = false;
    };
  }, [tokenHash, type, router, locale]);

  if (failed) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <h1 className="text-lg font-semibold">{t("auth.activationFailedTitle")}</h1>
        <p className="text-sm text-(--color-muted)">{t("auth.activationFailed")}</p>
        <Button
          onClick={() =>
            router.push(`/${locale}/verify-email?email=${encodeURIComponent(email)}`)
          }
        >
          {t("auth.activationRetry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <span
        aria-hidden
        className="h-5 w-5 animate-spin rounded-full border-2 border-current border-e-transparent text-(--color-muted)"
      />
      <p className="text-sm text-(--color-muted)">{t("auth.activationVerifying")}</p>
    </div>
  );
}
