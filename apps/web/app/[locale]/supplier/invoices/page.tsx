import { ComingSoonPage } from "@/components/layout/ComingSoonPage";
import { FinancingGate } from "@/components/onboarding/FinancingGate";

/**
 * Invoice submission is a financing action, so it sits behind the ZM-SON-011
 * gate. The screen itself ships in Phase 3; the gate is wired now so the rule
 * is enforced from the moment the screen exists rather than retrofitted.
 */
export default function Page() {
  return (
    <FinancingGate>
      <ComingSoonPage title="Invoices" />
    </FinancingGate>
  );
}
