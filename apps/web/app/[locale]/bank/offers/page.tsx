"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "@/lib/i18n/dictionary-context";
import { Table, type TableColumn } from "@/components/ui/Table";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Tabs } from "@/components/ui/Tabs";
import { ErrorState } from "@/components/ui/StatePanels";
import { MoneyDisplay } from "@/components/money/MoneyDisplay";
import { useSession } from "@/lib/session/SessionProvider";
import { approveOfferById, useBankOffers, withdrawOfferById, type OfferWithCreator } from "@/lib/marketplace/useOffers";
import { ApiError } from "@/lib/api/client";

/**
 * "My offers" and the internal approval queue — the same read
 * (`GET /offers`, this bank's own organization) with different status
 * filters, per `useBankOffers`'s own reasoning. `ZM-OFR-016`/`ZM-ROL-002`:
 * the approve action is **hidden**, not merely disabled, when the signed-in
 * user is the offer's own creator — the server independently refuses the
 * same case (`SELF_APPROVAL_FORBIDDEN`), so this is a courtesy layer, not
 * the boundary.
 */
export default function BankOffersPage() {
  const t = useTranslations();
  const params = useParams<{ locale: string }>();
  const locale = params?.locale === "ar" ? "ar" : "en";

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">{t("nav.offers")}</h1>
      <Tabs
        items={[
          { id: "my-offers", label: t("marketplace.offers.myOffersTab"), content: <MyOffers locale={locale} /> },
          {
            id: "approval-queue",
            label: t("marketplace.offers.approvalQueueTab"),
            content: <ApprovalQueue locale={locale} />,
          },
        ]}
      />
    </div>
  );
}

function MyOffers({ locale }: { locale: "en" | "ar" }) {
  const t = useTranslations();
  const { data, loading, error, reload } = useBankOffers();
  const { me } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function withdraw(offerId: string) {
    setBusyId(offerId);
    setActionError(null);
    try {
      await withdrawOfferById(offerId);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return <ErrorState title={t("portal.errorLoadingData")} onRetry={reload} retryLabel={t("common.retry")} />;
  }

  const columns: TableColumn<OfferWithCreator>[] = [
    {
      key: "version",
      header: t("marketplace.offers.column.version"),
      render: (row) => (
        <Link href={`/${locale}/bank/offers/${row.id}`} className="underline underline-offset-2">
          v{row.versionNumber ?? 1}
        </Link>
      ),
    },
    { key: "status", header: t("marketplace.offers.column.status"), render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "net",
      header: t("marketplace.offers.column.netSupplierPayout"),
      align: "end",
      render: (row) => (row.netSupplierPayout ? <MoneyDisplay value={row.netSupplierPayout} locale={locale} /> : "—"),
    },
    {
      key: "creator",
      header: t("marketplace.offers.column.creator"),
      render: (row) => row.createdByUserName ?? "—",
    },
    {
      key: "action",
      header: "",
      align: "end",
      render: (row) =>
        row.status === "ACTIVE" || row.status === "PENDING_INTERNAL_APPROVAL" ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busyId === row.id}
            onClick={() => row.id && withdraw(row.id)}
          >
            {t("marketplace.offers.withdraw")}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="mt-4">
      {actionError && <p className="mb-3 text-sm text-(--color-danger)">{actionError}</p>}
      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id ?? ""}
        loading={loading}
        emptyMessage={t("marketplace.offers.myOffersEmpty")}
      />
      <p className="mt-3 text-xs text-(--color-muted)">
        {t("marketplace.offers.currentUser", { name: me?.user?.fullName ?? "—" })}
      </p>
    </div>
  );
}

function ApprovalQueue({ locale }: { locale: "en" | "ar" }) {
  const t = useTranslations();
  const { data, loading, error, reload } = useBankOffers("PENDING_INTERNAL_APPROVAL");
  const { me } = useSession();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function approve(offerId: string) {
    setBusyId(offerId);
    setActionError(null);
    try {
      await approveOfferById(offerId);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.unknownError"));
    } finally {
      setBusyId(null);
    }
  }

  if (error) {
    return <ErrorState title={t("portal.errorLoadingData")} onRetry={reload} retryLabel={t("common.retry")} />;
  }

  const columns: TableColumn<OfferWithCreator>[] = [
    {
      key: "creator",
      header: t("marketplace.offers.column.creator"),
      render: (row) => row.createdByUserName ?? "—",
    },
    {
      key: "net",
      header: t("marketplace.offers.column.netSupplierPayout"),
      align: "end",
      render: (row) => (row.netSupplierPayout ? <MoneyDisplay value={row.netSupplierPayout} locale={locale} /> : "—"),
    },
    { key: "version", header: t("marketplace.offers.column.version"), render: (row) => `v${row.versionNumber ?? 1}` },
    {
      key: "action",
      header: "",
      align: "end",
      render: (row) => {
        const isOwnOffer = !!me?.user?.id && row.createdByUserId === me.user.id;
        // The approve action is hidden (not disabled) for the offer's own
        // creator — ZM-ROL-002 is a hard server-side rule, and hiding
        // rather than greying out avoids a maker learning "you can't do
        // this" only after clicking.
        if (isOwnOffer) {
          return <span className="text-xs text-(--color-muted)">{t("marketplace.offers.ownOfferNote")}</span>;
        }
        return (
          <Button type="button" size="sm" disabled={busyId === row.id} onClick={() => row.id && approve(row.id)}>
            {t("marketplace.offers.approve")}
          </Button>
        );
      },
    },
  ];

  return (
    <div className="mt-4">
      {actionError && <p className="mb-3 text-sm text-(--color-danger)">{actionError}</p>}
      <Table
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id ?? ""}
        loading={loading}
        emptyMessage={t("marketplace.offers.approvalQueueEmpty")}
      />
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const t = useTranslations();
  if (!status) return null;
  const tone = status === "ACTIVE" ? "success" : status === "WITHDRAWN" || status === "NOT_SELECTED" ? "neutral" : "info";
  return <Badge tone={tone}>{t(`marketplace.offer.status.${status}`)}</Badge>;
}
