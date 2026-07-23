import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, renderLive, signIn, useSessionForApi, type Session } from "./harness";
import { apiClient } from "@/lib/api/client";
import { BuyerStep } from "@/components/invoices/BuyerStep";

/**
 * The invoice wizard's whole leg, live — the demo's opening act.
 *
 * Step 1 is rendered for real: `BuyerStep` searching the real registry
 * mirror, and the assertion that matters is ZM-BUY-009's — the screen shows
 * candidates and never pre-selects one; choosing is the supplier's act. The
 * remaining steps drive exactly the calls the wizard's handlers make (they
 * are inline in the component, same `apiClient`, same generated types):
 * draft → invoice → buyer link → floor → declarations → e-invoice upload →
 * submit. Submit is the step that earns the walk: real automated checks,
 * real government adapters, real OCR comparison, real risk scoring — the
 * transaction must come back ELIGIBLE with a verification run a screen can
 * render.
 *
 * The chain is cancelled afterwards (a recorded CANCELLED, never a delete),
 * so the demo population gains nothing from test runs.
 */

const MONEY_RE = /^\d+\.\d{3}$/;

describe("the invoice wizard leg against the live API", () => {
  let supplier: Session;
  let txId: string;
  let buyerId: string | undefined;

  beforeAll(async () => {
    supplier = await signIn("supplier");
  });

  afterAll(async () => {
    if (txId) {
      await apiFetch(supplier, `/transactions/${txId}/cancel`, {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ reason: "Live wizard test teardown." }),
      }).catch(() => undefined);
    }
  });

  it("searches buyers in the real registry and never pre-selects one (ZM-BUY-009)", async () => {
    useSessionForApi(supplier);

    let selected: { id?: string } | null = null;
    renderLive(
      <BuyerStep
        selectedBuyer={null}
        contact={{}}
        onChange={({ buyer }) => {
          selected = buyer;
        }}
      />
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Amman" } });
    const search = screen.getByRole("button", { name: /search|بحث/i });
    fireEvent.click(search);

    await waitFor(
      () => {
        // Real candidates from the live registry mirror.
        expect(screen.getAllByRole("radio").length).toBeGreaterThan(0);
      },
      { timeout: 30_000 }
    );

    // Rendered, not chosen: no candidate arrives pre-selected, and nothing
    // has been reported upward until the supplier acts.
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
    expect(selected).toBeNull();
  });

  it("walks draft → invoice → buyer → floor → declarations → upload → submit to ELIGIBLE", async () => {
    useSessionForApi(supplier);
    const suffix = randomUUID().slice(0, 8).toUpperCase();

    // Draft — the wizard's entry.
    const draft = await apiClient.POST("/transactions", {});
    expect(draft.error).toBeUndefined();
    txId = (draft.data as { id: string }).id;

    // Resolve the buyer the way BuyerStep's chooser does.
    const resolve = await apiClient.POST("/buyers/resolve", {
      body: { nationalEstablishmentNumber: "30000201", confirmedByUser: true },
    });
    expect(resolve.error).toBeUndefined();
    buyerId = (resolve.data as { id: string }).id;

    // Invoice steps, exactly the wizard handlers' bodies.
    // Every field is the uploaded PDF's own, including the number and the
    // e-invoice identifier: the OCR/QR comparisons are real, and declared
    // values that contradict the document put the transaction into
    // UNDER_REVIEW — correctly. The teardown's cancel releases the
    // fingerprint (D-01's partial-active index), so the next run does not
    // collide with this one.
    const invoice = await apiClient.PUT("/transactions/{id}/invoice", {
      params: { path: { id: txId } },
      body: {
        invoiceNumber: "INV-2026-0001",
        einvoiceIdentifier: "JO-EINV-20000101-0001",
        issueDate: "2026-05-10",
        dueDate: "2026-08-10",
        subtotalAmount: "10650.000",
        taxAmount: "1704.000",
        faceValue: "12354.000",
      },
    });
    expect(invoice.error, JSON.stringify(invoice.error)).toBeUndefined();
    // The server recomputes outstanding; it never took it from us.
    expect(String((invoice.data as Record<string, unknown>).outstandingAmount)).toMatch(MONEY_RE);

    const link = await apiClient.PUT("/transactions/{id}/buyer", {
      params: { path: { id: txId } },
      body: { buyerId: buyerId! },
    });
    expect(link.error, JSON.stringify(link.error)).toBeUndefined();

    const floor = await apiClient.PUT("/transactions/{id}/minimum-amount", {
      params: { path: { id: txId } },
      body: { minimumAcceptableAmount: "8000.000" },
    });
    expect(floor.error, JSON.stringify(floor.error)).toBeUndefined();

    const declarations = await apiClient.POST("/transactions/{id}/declarations", {
      params: { path: { id: txId } },
      body: {
        declarationTemplateVersion: "1.0",
        isAuthentic: true,
        goodsDelivered: true,
        unpaidAndNotCancelled: true,
        noKnownDispute: true,
        notPreviouslyFinanced: true,
        buyerIsNamedEntity: true,
        contactIsBuyerRep: true,
        acceptsRecourse: true,
      },
    });
    expect(declarations.error, JSON.stringify(declarations.error)).toBeUndefined();

    // The mandatory e-invoice, through the signed-URL flow the upload step
    // uses (the byte PUT is the browser's own; the service key never appears).
    const pdf = readFileSync(
      join(__dirname, "..", "..", "..", "..", "db", "seed", "einvoices", "INV-2026-0001-alnoor-amman-retail.pdf")
    );
    const uploadUrl = await apiClient.POST("/documents/upload-url", {
      body: {
        documentType: "ELECTRONIC_INVOICE",
        fileName: `INV-LIVE-${suffix}.pdf`,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        subjectType: "TRANSACTION",
        subjectId: txId,
      },
    });
    expect(uploadUrl.error, JSON.stringify(uploadUrl.error)).toBeUndefined();
    const issued = uploadUrl.data as { uploadUrl: string; documentId: string };
    const put = await fetch(issued.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array(pdf),
    });
    expect(put.ok).toBe(true);

    // The extraction read the wizard's step 2 performs — genuine OCR over
    // the uploaded pixels, and the finalization that hashes the file.
    const extraction = await apiClient.GET("/documents/{id}/extraction", {
      params: { path: { id: issued.documentId } },
    });
    expect(extraction.error, JSON.stringify(extraction.error)).toBeUndefined();

    // Submit: the automated checks run for real. ELIGIBLE or bust.
    const submit = await apiClient.POST("/transactions/{id}/submit", {
      params: { path: { id: txId } },
    });
    expect(submit.error, JSON.stringify(submit.error)).toBeUndefined();
    expect((submit.data as { state?: string }).state).toBe("ELIGIBLE");

    // And the verification panel's read renders from a real run.
    const verification = await apiClient.GET("/transactions/{id}/verification", {
      params: { path: { id: txId } },
    });
    expect(verification.error, JSON.stringify(verification.error)).toBeUndefined();
    const run = verification.data as { checks?: { checkType?: string; status?: string }[] };
    expect(Array.isArray(run.checks)).toBe(true);
    expect(run.checks!.length).toBeGreaterThan(0);
  }, 180_000);
});
