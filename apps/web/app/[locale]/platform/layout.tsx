import { PortalShell } from "@/components/layout/PortalShell";

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell portal="platform">{children}</PortalShell>;
}
