"use client";

import { useParams, useRouter } from "next/navigation";
import { mockUsers, type MockPersonaKey } from "@/lib/mocks/data";
import { setStoredPersona } from "@/lib/mocks/persona-store";
import { Button } from "@/components/ui/Button";

const MOCKING_ENABLED = process.env.NEXT_PUBLIC_API_MOCKING !== "disabled";

/**
 * Dev-only shortcut for exercising all three portals before Agent A's
 * /auth/me is live — no real Supabase project required. Hidden entirely
 * once NEXT_PUBLIC_API_MOCKING=disabled.
 */
export function DevPersonaPicker() {
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  if (!MOCKING_ENABLED) return null;

  function enterAs(persona: MockPersonaKey) {
    setStoredPersona(persona);
    router.push(`/${locale}`);
  }

  return (
    <div className="mt-4 rounded-lg border border-dashed border-(--color-warning) bg-(--color-warning-bg) p-3">
      <p className="mb-2 text-xs font-medium text-(--color-warning)">
        Dev only — mock personas (no backend yet)
      </p>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(mockUsers) as MockPersonaKey[]).map((key) => (
          <Button key={key} type="button" variant="secondary" size="sm" onClick={() => enterAs(key)}>
            {mockUsers[key].memberships[0].organizationName}
          </Button>
        ))}
      </div>
    </div>
  );
}
