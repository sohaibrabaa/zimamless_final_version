import { EmptyState } from "@/components/ui/StatePanels";

/** Placeholder for nav destinations that ship in a later phase — keeps every nav link resolving instead of 404ing (Phase 1 exit bar). */
export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">{title}</h1>
      <EmptyState title="Coming soon" description="This screen ships in a later phase of the build plan." />
    </div>
  );
}
