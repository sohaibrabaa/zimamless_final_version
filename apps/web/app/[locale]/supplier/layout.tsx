import { PortalShell } from "@/components/layout/PortalShell";

export default function SupplierLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell portal="supplier">{children}</PortalShell>;
}
