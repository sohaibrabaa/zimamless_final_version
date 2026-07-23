"use client";

import { useState } from "react";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/StatePanels";
import { markNotificationRead, useInbox } from "@/lib/payments/usePayments";

/**
 * The in-platform inbox, shared by all three portals.
 *
 * One component rather than three because a notification is addressed to a
 * *person*, not to an organization — the same user switching context between a
 * supplier and a platform membership has one inbox, and the API scopes it by
 * `recipient_user_id` alone.
 *
 * Marking read is what sets `DELIVERED` server-side: for an in-platform
 * message, a user opening it is the only delivery the platform can honestly
 * claim to have observed.
 */
export function NotificationInbox() {
  const t = useTranslations();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const inbox = useInbox(unreadOnly);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function markRead(id: string) {
    setBusyId(id);
    try {
      await markNotificationRead(id);
      inbox.reload();
    } finally {
      setBusyId(null);
    }
  }

  if (inbox.loading) return <SkeletonText lines={5} />;
  if (inbox.error) {
    return <ErrorState title={inbox.error} onRetry={inbox.reload} retryLabel={t("common.retry")} />;
  }

  const data = inbox.data ?? { items: [], unreadCount: 0 };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t("payments.inbox.title")}</h1>
        {data.unreadCount > 0 && (
          <Badge tone="info">
            {t("payments.inbox.unreadCount", { count: String(data.unreadCount) })}
          </Badge>
        )}
        <label className="ms-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />
          {t("payments.inbox.unreadOnly")}
        </label>
      </div>

      {data.items.length === 0 ? (
        <EmptyState title={t("payments.inbox.empty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {data.items.map((item) => (
            <li
              key={item.id}
              className={
                "rounded-lg border p-4 " +
                (item.read
                  ? "border-(--color-border)"
                  : "border-(--color-primary) bg-(--color-neutral-bg)")
              }
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">{item.subject}</h2>
                <time className="text-xs text-(--color-muted)" dateTime={item.queuedAt}>
                  {item.queuedAt.slice(0, 10)}
                </time>
              </div>
              <p className="mt-2 text-sm text-(--color-fg)">{item.body}</p>

              {!item.read && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  loading={busyId === item.id}
                  onClick={() => markRead(item.id)}
                >
                  {t("payments.inbox.markRead")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
