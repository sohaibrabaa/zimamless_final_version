import { PortalShell } from "@/components/layout/PortalShell";

export default function BankLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell portal="bank">{children}</PortalShell>;
}
