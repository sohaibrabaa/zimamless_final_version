import { ComingSoonPage } from "@/components/layout/ComingSoonPage";
import { FinancingGate } from "@/components/onboarding/FinancingGate";

/** Financing action — gated by ZM-SON-011 (see components/onboarding/FinancingGate.tsx). */
export default function Page() {
  return (
    <FinancingGate>
      <ComingSoonPage title="Payments" />
    </FinancingGate>
  );
}
