"use client";

import { useState } from "react";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { TimeMachineControl } from "@/components/dev/TimeMachineControl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Table, type TableColumn } from "@/components/ui/Table";
import { ErrorState } from "@/components/ui/StatePanels";
import { SkeletonText } from "@/components/ui/Skeleton";
import {
  patchPlatformSettings,
  useCommissionTiers,
  usePlatformSettings,
  type CommissionTier,
} from "@/lib/admin/useAdmin";
import { formatMoneyDisplay } from "@/lib/money";

/**
 * Platform settings — the `/admin/settings` editor plus the demo clock.
 *
 * Editing is deliberately narrow: the keys listed in EDITABLE are the ones
 * an operator legitimately tunes between demos (reminder cadence, escalation
 * window, the time-machine arm switch). Everything else the endpoint returns
 * renders read-only — visible because an operator should be able to *see*
 * the platform's configuration, uneditable because a generic JSON editor
 * over every key is a footgun with an audit trail. The server refuses
 * unknown keys with a 422 regardless; the whitelist here is UX, not the
 * security boundary.
 */

const EDITABLE = new Set([
  "maturity_reminder_days",
  "reminder_thresholds_pct",
  "funding_confirmation_escalation_hours",
  "demo_time_machine_enabled",
]);

function SettingRow({
  name,
  value,
  onSaved,
}: {
  name: string;
  value: unknown;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState(JSON.stringify(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = EDITABLE.has(name);

  async function save() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError(t("admin.settings.invalidJson"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await patchPlatformSettings({ [name]: parsed });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.unknownError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-(--color-border) py-2 last:border-b-0">
      <code className="min-w-64 text-xs">{name}</code>
      {editable ? (
        <>
          <div className="w-56">
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={name} />
          </div>
          <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => void save()}>
            {t("common.save")}
          </Button>
        </>
      ) : (
        <code className="text-xs text-(--color-muted)">{JSON.stringify(value)}</code>
      )}
      {error && <p className="w-full text-sm text-(--color-danger)">{error}</p>}
    </div>
  );
}

export default function Page() {
  const t = useTranslations();
  const settings = usePlatformSettings();
  const tiers = useCommissionTiers();

  const tierColumns: TableColumn<CommissionTier>[] = [
    {
      key: "range",
      header: t("admin.tiers.range"),
      render: (row) => (
        <span className="tabular-nums">
          {formatMoneyDisplay(row.minTransactionAmount ?? "0.000")}
          {" – "}
          {row.maxTransactionAmount ? formatMoneyDisplay(row.maxTransactionAmount) : "∞"}
        </span>
      ),
    },
    {
      key: "pct",
      header: t("admin.tiers.percentage"),
      render: (row) => <span className="tabular-nums">{row.commissionPercentage}%</span>,
    },
    {
      key: "fixed",
      header: t("admin.tiers.fixed"),
      render: (row) => (
        <span className="tabular-nums">
          {row.fixedCommissionAmount ? formatMoneyDisplay(row.fixedCommissionAmount) : "—"}
        </span>
      ),
    },
    { key: "payer", header: t("admin.tiers.payer"), render: (row) => row.feePayer ?? "—" },
    {
      key: "active",
      header: t("admin.tiers.active"),
      render: (row) => (row.isActive ? t("admin.tiers.yes") : t("admin.tiers.no")),
    },
  ];

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="mb-4 text-lg font-semibold">{t("nav.settings")}</h1>
        <TimeMachineControl />
      </div>

      <section>
        <h2 className="mb-1 text-base font-semibold">{t("admin.settings.title")}</h2>
        <p className="mb-3 text-sm text-(--color-muted)">{t("admin.settings.subtitle")}</p>
        {settings.loading && <SkeletonText lines={4} />}
        {settings.error && (
          <ErrorState title={settings.error} onRetry={settings.reload} retryLabel={t("common.retry")} />
        )}
        {settings.data && (
          <div className="rounded-lg border border-(--color-border) px-3">
            {Object.entries(settings.data)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, value]) => (
                <SettingRow key={name} name={name} value={value} onSaved={settings.reload} />
              ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-base font-semibold">{t("admin.tiers.title")}</h2>
        <p className="mb-3 text-sm text-(--color-muted)">{t("admin.tiers.subtitle")}</p>
        {tiers.error ? (
          <ErrorState title={tiers.error} onRetry={tiers.reload} retryLabel={t("common.retry")} />
        ) : (
          <Table
            columns={tierColumns}
            rows={tiers.data ?? []}
            rowKey={(row) => row.id ?? JSON.stringify(row)}
            emptyMessage={t("admin.tiers.empty")}
            loading={tiers.loading}
          />
        )}
      </section>
    </div>
  );
}
