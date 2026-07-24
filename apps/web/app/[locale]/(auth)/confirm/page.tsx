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
 * client-side against Supabase Auth). The link carries Supabase's own
 * single-use confirmation token as `token_hash`; verifyOtp validates it
 * server-side at Supabase, consumes it, and establishes the session. No
 * custom tokens, no API involvement — the NestJS API only ever sees the
 * resulting JWT.
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
    if (!tokenHash || started.current) return;
    started.current = true;

    supabase.auth.verifyOtp({ type, token_hash: tokenHash }).then(({ error }) => {
      if (error) {
        setFailed(true);
        return;
      }
      router.replace(`/${locale}`);
    });
  }, [tokenHash, type, router, locale]);

  if (failed || !tokenHash) {
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
