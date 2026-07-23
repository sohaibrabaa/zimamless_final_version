"use client";

import { useTranslations } from "@/lib/i18n/dictionary-context";
import { TimeMachineControl } from "@/components/dev/TimeMachineControl";

/**
 * Platform settings.
 *
 * The route sits under `platform/`, so the portal layout already scopes it to
 * platform staff. The demo time machine lives here because it is an operator
 * tool, not a feature — and its real guard is server-side (a 404 unless armed),
 * so placement is for tidiness, not security.
 *
 * Phase 9 will grow this screen into the `/admin/settings` editor; today it
 * hosts the one control the demo cannot run without.
 */
export default function Page() {
  const t = useTranslations();

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-lg font-semibold">{t("nav.settings")}</h1>
      <TimeMachineControl />
    </div>
  );
}
