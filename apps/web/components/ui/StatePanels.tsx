import type { ReactNode } from "react";
import { Button } from "./Button";

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-(--color-border) px-6 py-12 text-center">
      <p className="text-sm font-medium text-(--color-fg)">{title}</p>
      {description && <p className="text-sm text-(--color-muted)">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  onRetry,
  retryLabel = "Retry",
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-2 rounded-lg border border-(--color-danger) bg-(--color-danger-bg) px-6 py-12 text-center"
    >
      <p className="text-sm font-medium text-(--color-danger)">{title}</p>
      {description && <p className="text-sm text-(--color-danger)">{description}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
