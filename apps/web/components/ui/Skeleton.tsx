import { clsx } from "@/lib/clsx";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={clsx("animate-pulse rounded-md bg-(--color-neutral-bg)", className)}
    />
  );
}

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={clsx("h-3", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
