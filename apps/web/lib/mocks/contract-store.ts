/**
 * Contract generation and signing (§13), built on top of the accepted-offer
 * snapshot `acceptOffer` writes in `marketplace-store.ts`. A contract can
 * only be generated from that snapshot — never from the live offer — so
 * ZM-SEL-008 (the snapshot survives the source offer being modified or
 * superseded) is structural here rather than merely intended.
 *
 * Templates are a real per-`transactionType` engine with a default
 * fallback (ZM-CON-002), EN + AR (ZM-I18N-005), rendered from the
 * snapshot's frozen fields plus verified party identity — never from the
 * live offer or transaction (ZM-CON-001).
 */
import { contentHash, preContractCheckFailures, isFullySigned, type PreContractCheckFailure } from "@/lib/contracts/contract-domain";
import { findApplicationByOrganization } from "./onboarding-store";
import {
  findSnapshotByConditionId,
  findSnapshotForTransaction,
  type AcceptedOfferSnapshotRecord,
} from "./marketplace-store";
import { findTransaction, setTransactionState } from "./transaction-store";

export type ContractStatus = "PENDING_SIGNATURES" | "FULLY_SIGNED";

interface ContractSignatureRecord {
  organizationType: "SUPPLIER" | "BANK";
  signerName: string;
  signerCapacity: string;
  status: "SIGNED";
  signedAt: string;
}

export interface ContractRecord {
  id: string;
  transactionId: string;
  contractNumber: string;
  status: ContractStatus;
  templateVersion: string;
  canonicalLanguage: "EN";
  documentId: string;
  documentHash: string;
  bodyEn: string;
  bodyAr: string;
  signatures: ContractSignatureRecord[];
  generatedAt: string;
  fullySignedAt?: string;
}

let contracts: ContractRecord[] = [];
let contractCounter = 5000;

export function resetContractMocks() {
  contracts = [];
  contractCounter = 5000;
}

const TEMPLATE_VERSION = "1.0";

/**
 * One template per `transactionType`, falling back to a generic template —
 * ZM-CON-002. Every template reads only from the frozen snapshot and the
 * two parties' verified identity, never from the live offer.
 */
function renderContractBody(
  snapshot: AcceptedOfferSnapshotRecord,
  supplierName: string,
  language: "en" | "ar"
): string {
  const lines =
    language === "en"
      ? [
          `RECEIVABLE FINANCING AGREEMENT (${snapshot.transactionType.replaceAll("_", " ")})`,
          `Supplier: ${supplierName}`,
          `Bank: ${snapshot.bankName}`,
          `Recourse: ${snapshot.recourseType.replaceAll("_", " ")}`,
          `Gross funding amount: ${snapshot.grossFundingAmount} JOD`,
          `Net supplier payout: ${snapshot.netSupplierPayout} JOD`,
          `Conditions: ${snapshot.conditions.length}`,
          `This document is generated from the accepted offer snapshot and is not editable.`,
        ]
      : [
          `اتفاقية تمويل الذمم المدينة (${snapshot.transactionType.replaceAll("_", " ")})`,
          `المورّد: ${supplierName}`,
          `البنك: ${snapshot.bankName}`,
          `حق الرجوع: ${snapshot.recourseType.replaceAll("_", " ")}`,
          `مبلغ التمويل الإجمالي: ${snapshot.grossFundingAmount} دينار`,
          `صافي المبلغ المستحق للمورّد: ${snapshot.netSupplierPayout} دينار`,
          `عدد الشروط: ${snapshot.conditions.length}`,
          `هذا المستند مولّد من لقطة العرض المقبول وغير قابل للتعديل.`,
        ];
  return lines.join("\n");
}

function bankAccountVerifiedFor(organizationId: string): boolean {
  return !!findApplicationByOrganization(organizationId)?.bankAccount;
}

export type GenerateContractResult =
  | { ok: true; contract: ContractRecord }
  | { ok: false; error: "NOT_ACCEPTED" | "NOT_FOUND" }
  | { ok: false; error: "PRE_CONTRACT_CHECK_FAILED"; failures: PreContractCheckFailure[] };

/** ZM-CON-006: pre-contract checks; ZM-CON-001..003: template + version recorded. */
export function generateContract(transactionId: string): GenerateContractResult {
  const existing = contracts.find((c) => c.transactionId === transactionId);
  if (existing) return { ok: true, contract: existing };

  const transaction = findTransaction(transactionId);
  if (!transaction) return { ok: false, error: "NOT_FOUND" };
  const snapshot = findSnapshotForTransaction(transactionId);
  if (!snapshot) return { ok: false, error: "NOT_ACCEPTED" };

  const failures = preContractCheckFailures({
    conditions: snapshot.conditions,
    declarationTemplateVersion: transaction.declarationTemplateVersion,
    bankAccountVerified: bankAccountVerifiedFor(transaction.organizationId),
  });
  if (failures.length > 0) return { ok: false, error: "PRE_CONTRACT_CHECK_FAILED", failures };

  const application = findApplicationByOrganization(transaction.organizationId);
  const supplierName = application?.organizationName ?? "Supplier";

  contractCounter += 1;
  const bodyEn = renderContractBody(snapshot, supplierName, "en");
  const bodyAr = renderContractBody(snapshot, supplierName, "ar");

  const contract: ContractRecord = {
    id: `0efc0000-0000-4000-8000-${String(contractCounter).padStart(12, "0")}`,
    transactionId,
    contractNumber: `ZM-CTR-${contractCounter}`,
    // Generation and signing are one call each in this mock — there is no
    // separate "GENERATED, unsent" moment to model, matching the transient-
    // state discipline the Phase 2/3 stores already established.
    status: "PENDING_SIGNATURES",
    templateVersion: TEMPLATE_VERSION,
    // ZM-I18N-003b: EN governs regardless of which language a party reads.
    canonicalLanguage: "EN",
    documentId: `0efd0000-0000-4000-8000-${String(contractCounter).padStart(12, "0")}`,
    documentHash: contentHash(bodyEn),
    bodyEn,
    bodyAr,
    signatures: [],
    generatedAt: new Date().toISOString(),
  };
  contracts = [...contracts, contract];
  return { ok: true, contract };
}

export function findContractForTransaction(transactionId: string): ContractRecord | undefined {
  return contracts.find((c) => c.transactionId === transactionId);
}

export function findContractById(id: string): ContractRecord | undefined {
  return contracts.find((c) => c.id === id);
}

export type SignContractResult =
  | { ok: true; contract: ContractRecord }
  | { ok: false; error: "NOT_FOUND" | "ALREADY_SIGNED" | "DECLINED" };

/** ZM-CON-008/010/011/012. Authorization (is this caller allowed to sign?) is the handler's job, same as every other role check in this codebase — this function trusts `organizationType` once it is called. */
export function signContract(
  contractId: string,
  organizationType: "SUPPLIER" | "BANK",
  signerName: string,
  signerCapacity: string,
  accepted: boolean
): SignContractResult {
  const contract = findContractById(contractId);
  if (!contract) return { ok: false, error: "NOT_FOUND" };
  if (!accepted) return { ok: false, error: "DECLINED" };
  if (contract.signatures.some((s) => s.organizationType === organizationType)) {
    return { ok: false, error: "ALREADY_SIGNED" };
  }

  contract.signatures = [
    ...contract.signatures,
    { organizationType, signerName, signerCapacity, status: "SIGNED", signedAt: new Date().toISOString() },
  ];

  if (isFullySigned(contract.signatures)) {
    contract.status = "FULLY_SIGNED";
    contract.fullySignedAt = new Date().toISOString();
    // A's task list is explicit: "FULLY_SIGNED when all required signatures
    // verified → state CONTRACTED" — the transaction only reaches CONTRACTED
    // here, never at generation.
    setTransactionState(contract.transactionId, "CONTRACTED");
  }

  return { ok: true, contract };
}

export function conditionsForTransaction(transactionId: string) {
  return findSnapshotForTransaction(transactionId)?.conditions ?? [];
}

export type FulfilConditionResult = { ok: true } | { ok: false; error: "NOT_FOUND" };

/** `POST /conditions/{id}/fulfil` — evidence documents + notes recorded, fulfilment marked FULFILLED. */
export function fulfilCondition(
  conditionId: string,
  documentIds: string[],
  notes: string | undefined
): FulfilConditionResult {
  const snapshot = findSnapshotByConditionId(conditionId);
  const condition = snapshot?.conditions.find((c) => c.id === conditionId);
  if (!condition) return { ok: false, error: "NOT_FOUND" };
  condition.fulfilment = "FULFILLED";
  condition.evidenceDocumentIds = documentIds;
  condition.fulfilmentNotes = notes;
  return { ok: true };
}
