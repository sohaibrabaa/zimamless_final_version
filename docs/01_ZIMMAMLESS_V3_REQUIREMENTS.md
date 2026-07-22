# Zimmamless — V3 Consolidated System Requirements

**Version:** 3.0
**Date:** July 2026
**Jurisdiction of operation:** Hashemite Kingdom of Jordan
**Status:** Competition-planning authority document
**Supersedes:** `Zimmamless_Complete_System_Requirements_EN1.pdf` (V2.0), `Zimmamless_Logical_Class_Diagram_Report.md`, `Zimmamless_Logical_Class_Diagram.mermaid`, `zimmamless_workflow_diagram.html`

---

## Document Control

### Authority

Where any previous Zimmamless document conflicts with this document, **this document governs**. The V2.0 PDF, the earlier logical class diagram, and the earlier workflow diagram are retained for historical reference only and must not be used as an implementation source.

### Legal disclaimer and the `LEGAL_TBD_POST_COMPETITION` convention

Zimmamless operates in a domain touching financial regulation, assignment of receivables, data protection, and contract enforceability. **No legal, regulatory, licensing, contractual, enforceability, liability, privacy, data-residency, assignment, perfection, or formal-notification question is settled by this document.**

All such questions are marked inline with the tag:

> `LEGAL_TBD_POST_COMPETITION`

and are additionally collected in **Appendix A — Legal TBD Register**.

These items:

- will be resolved after the competition with qualified legal and financial specialists;
- **must not block** product definition, architecture, database design, API design, UX, or implementation planning;
- are handled in the technical system through **configurable policies, provider adapters, document templates, and enumerations**, so that final legal rules can be applied later without redesigning the core platform.

Every `LEGAL_TBD_POST_COMPETITION` item in this document is accompanied by the **current technical assumption** the platform implements in the interim.

### Reading conventions

| Marker | Meaning |
|---|---|
| **MUST** | Mandatory requirement for the V3 release. |
| **SHOULD** | Strongly recommended; deviation requires a recorded decision. |
| **MAY** | Optional or future-phase. |
| `CONFIGURABLE` | Value or behaviour is an administrator-managed platform policy, not a hard-coded constant. |
| `LEGAL_TBD_POST_COMPETITION` | Legal question deferred; technical assumption stated alongside. |
| `ASSUMPTION` | A gap filled by the authoring team, subject to owner override in review. |

### Requirement identifiers

Requirements are identified as `ZM-<MODULE>-<NNN>`, e.g. `ZM-OFR-014`. Module codes are listed in §4.2.

---

## 1. Executive Summary

Zimmamless is a **digital receivables marketplace** operating in Jordan. It connects **suppliers** who hold unpaid, deferred commercial invoices with **licensed banks** willing to advance funds against those invoices.

The journey in one paragraph: a supplier registers using its national establishment number; the platform enriches the supplier profile automatically from government registries and reaches a decision within a 24-business-hour service level. The supplier then uploads an electronic invoice, identifies the buyer (who is resolved against the companies registry but is never a platform user), and states a private minimum acceptable net amount. The platform runs automated verification, duplicate detection, fraud screening, and a versioned Trust Score, then publishes the invoice as a **confidential, time-boxed marketplace listing** visible only to banks whose policy filters match. Banks submit competing offers, invisible to one another; only the supplier can compare them. The supplier accepts one offer at any time while the listing is open — acceptance is atomic and permanently locks the invoice. A contract is generated from a template, both parties sign electronically, the bank funds, and a **cross-party OTP** confirms funding participation from both sides. The platform then settles: gross funding in, platform commission and any unpaid listing fee deducted, net payout to the supplier. After funding, Zimmamless **continues to track the receivable** — maturity, partial payment, full payment, overdue, recourse, dispute, and closure — even though the buyer's payment to the bank happens entirely outside the platform.

### 1.1 What Zimmamless is

- An **electronic marketplace** and workflow platform.
- A **verification and data-enrichment** layer over Jordanian government registries.
- A **decision-support** provider producing transparent, versioned, explainable risk indicators.
- A **settlement orchestrator** for the single bank-to-supplier money movement it touches.
- A **system of record** with an immutable audit trail across the full receivable lifecycle.

### 1.2 What Zimmamless is not

- **Not a lender.** The platform never advances its own funds.
- **Not a guarantor.** It does not guarantee buyer repayment or bank recovery.
- **Not an adjudicator.** It records disputes and recourse cases; it does not decide them.
- **Not a collector.** Buyer-to-bank payment happens directly, outside the platform.
- **Not an auction.** There is no live bidding, no visible competing prices, and no automatic winner.

### 1.3 The ten defining rules of V3

1. **Neutral transaction model.** The core entity is `ReceivableTransaction`; the legal shape is a per-offer `transactionType`.
2. **Transparent money.** Every offer discloses a full deduction breakdown and a single net payout figure.
3. **Private floor.** The supplier's `minimumAcceptableAmount` is never visible to banks.
4. **Confidential offers.** No bank sees another bank's identity, amount, fees, or conditions.
5. **Immediate acceptance.** The supplier may accept at any time while the listing is open; acceptance is atomic and irreversible.
6. **No cheques.** Post-dated cheque handling is entirely out of scope in V3.
7. **Cross-party funding confirmation.** OTP participation from both bank and supplier is mandatory before `FUNDED`.
8. **Lifecycle continues after funding.** Monitoring, overdue, recourse, and dispute tracking are in scope.
9. **Never punish missing government data.** Source downtime or unpublished fields reduce data confidence; they never count as adverse evidence.
10. **Everything legal is configurable.** Templates, fee policies, penalty rules, recourse types, and retention rules are data, not code.

---

## 2. Change Log — V2 to V3

### 2.1 Removed

| Removed | Rationale |
|---|---|
| **All post-dated cheque functionality** — `PostDatedCheque`, `HandoverAppointment`, `ChequeHandover`, `HandoverReceipt`, cheque encryption/masking, in-person handover meeting, `REQUIRED_POST_DATED_CHEQUE` condition type, cheque status enums | Cheques are out of scope for V3. Any future cheque structure is `LEGAL_TBD_POST_COMPETITION`. |
| **Physical-presence requirement** for any platform step | No step in V3 requires the parties to meet in person. |
| **`requestedFinancingAmount`** field | Replaced by `minimumAcceptableAmount` as the single supplier-side amount input. |
| **Selection-after-deadline-only rule** (from the class diagram) | Superseded: the supplier may accept while the listing is open. |
| **Hard-coded purchase-only model** (`ReceivablePurchaseContract`, `acceptedPurchaseAmount` as the sole amount) | Superseded by the neutral `ReceivableTransaction` with configurable `transactionType`. |
| **Per-submission `Buyer` composition** | Superseded: `Buyer` is a global, deduplicated platform entity. |
| **Stripe named in the domain model** | Replaced by a provider-neutral settlement adapter. |

### 2.2 Retained from V2 (PDF)

| Retained | Notes |
|---|---|
| Government-first data model — supplier gives minimum data, platform enriches | Core to the product. |
| Self-declared data never overwrites government-source data | Retained verbatim. |
| 24-business-hour onboarding SLA with clock pause/resume | Retained; business calendar now explicitly configurable. |
| Application states including `INFORMATION_REQUIRED`, `GOVERNMENT_SERVICE_UNAVAILABLE`, `APPROVED_CONDITIONAL` | Retained. |
| Hard-rejection rules | Retained and extended. |
| Detailed buyer search and identity resolution, `BUYER_MANUAL_REVIEW` | Retained at full rigour. |
| Buyer is never a platform user | Retained and reinforced. |
| Supplier invoice declarations | Retained and extended. |
| Automated invoice checks (completeness, identity, duplicate, logic, eligibility, integrity) | Retained. |
| Five risk indicators | Retained, now alongside a composite score. |
| Government downtime must not reduce the score | Retained as a first-class rule. |
| Post-funding monitoring, overdue, recourse, dispute, fraud modules | Retained — explicitly back in scope. |
| Immutable audit log; financial records never deleted | Retained. |

### 2.3 New in V3

| New | Summary |
|---|---|
| **`ReceivableTransaction`** neutral core entity | Single lifecycle across all transaction types. |
| **`transactionType`** per offer | `INVOICE_FINANCING`, `RECEIVABLE_PURCHASE`, `RECEIVABLE_ASSIGNMENT`, `OTHER`. |
| **`recourseType`** as a first-class offer field | `FULL_RECOURSE`, `LIMITED_RECOURSE`, `NON_RECOURSE`, `OTHER`. |
| **Full offer money breakdown** | Six deduction components plus computed net payout. |
| **`minimumAcceptableAmount` as a net floor** | Compared against `netSupplierPayout`, not gross. |
| **Partial funding** | A bank may fund less than the full outstanding amount. |
| **Listing fee** | Incurred at listing activation, independent of funding outcome. |
| **Cross-party OTP funding confirmation** | Mandatory; replaces the removed cheque-handover OTP with a different purpose. |
| **`OVERDUE_UNCONFIRMED`** state | Distinguishes "bank has not reported" from "confirmed default". |
| **`WithdrawalCase`** with structured reason codes and configurable penalty policy | Post-acceptance bank withdrawal handling. |
| **Composite Trust Score (0–100) + risk band** | Alongside the five component indicators. |
| **Versioned scoring rules** | Historical scores retain their calculation version. |
| **Real ML pipeline** | Training, inference, versioning, metrics, explainability, fallback. |
| **OCR + QR extraction and cross-validation** | Mandatory electronic invoice; QR decoded and compared. |
| **Maker/approver separation** for bank offers | Mandatory; self-approval prohibited. |
| **Multi-organization user membership** with active-context switching | Many-to-many. |
| **Double-entry ledger** for platform-controlled financial legs | Reversals via compensating entries only. |
| **Bilingual English/Arabic with full RTL** | First-class requirement. |
| **Demo time machine** | Non-production maturity simulation. |
| **`LEGAL_TBD_POST_COMPETITION` register** | Formal deferral mechanism. |

### 2.4 Revised

| Area | V2 | V3 |
|---|---|---|
| Core transaction | Invoice financing with recourse (PDF) / outright purchase (class diagram) — contradictory | Neutral `ReceivableTransaction` with per-offer `transactionType` |
| Offer acceptance timing | Immediate (PDF) vs. after deadline (class diagram) — contradictory | Immediate, while listing open |
| Supplier amount input | `requestedFinancingAmount` | `minimumAcceptableAmount` (net floor, private) |
| Buyer entity | Per-submission composition | Global deduplicated entity + `SupplierBuyerRelationship` |
| Money flow | Bank pays supplier directly; platform fee unclear | Bank → configurable settlement adapter → commission + listing fee deducted → net payout |
| Commission recognition | Unspecified | Finalized only on `SUPPLIER_PAYOUT_COMPLETED` |
| Payment provider | Stripe adapter named | Provider-neutral `SettlementProvider` adapter |
| Risk output | Five indicators | Composite score + five indicators + reason codes + version |
| Deadlines | Undefined | Admin-configurable defaults: 24h offers, 12h selection |

---

## 3. Stakeholders and Actors

### 3.1 Actor summary

| Actor | Platform account | Core responsibility |
|---|---|---|
| **Supplier organization** | Yes | Registers the business, uploads invoices, resolves buyers, sets a minimum acceptable amount, compares offers, accepts one, signs, confirms funding, responds to recourse. |
| **Bank organization** | Yes | Configures policy filters, reviews eligible listings, creates and approves offers, signs, funds, confirms funding via OTP, reports buyer payments, initiates recourse. |
| **Platform administration** | Yes | Verifies supplier applications, manages the marketplace, configures fees and policies, reviews exceptions, supports users. |
| **Compliance function** | Yes | Reviews fraud cases, mismatches, sanctions concerns, and blocked entities. |
| **Buyer / debtor** | **No** | Stored as a resolved company record; owes the invoice; receives an outbound notification; has no login, no offers, no decision authority. |
| **Government registries** | N/A (system) | CCD, ISTD, GAM/licensing — read-only data sources via adapters. |
| **Settlement provider** | N/A (system) | Executes the bank-to-supplier money movement via adapter. |
| **Signature provider** | N/A (system) | Executes and verifies electronic signatures via adapter. |

### 3.2 The buyer's position — restated

`ZM-BUY-001` The buyer **MUST NOT** have a platform account, login, portal, or read-only view.
`ZM-BUY-002` The buyer **MUST NOT** approve, reject, or influence any offer, contract, or funding decision.
`ZM-BUY-003` The buyer **MUST** be resolved to a verified registry identity before an invoice becomes eligible.
`ZM-BUY-004` The buyer **MUST** receive an outbound notification after the transaction is confirmed (§13).
`ZM-BUY-005` Buyer contact details **MUST** be stored against the `SupplierBuyerRelationship`, not the global `Buyer`, because different suppliers legitimately hold different contacts at the same company.

> `LEGAL_TBD_POST_COMPETITION` — **LT-01.** Whether the buyer notification constitutes formal notice of assignment, whether buyer acknowledgement is legally required, and the legal basis for the platform processing buyer contact data provided by a third party (the supplier). **Technical assumption:** the platform sends an operational notification, stores full delivery evidence, supports correction and invalidation of contact data, and restricts access by role.

### 3.3 Role catalogue

#### 3.3.1 Bank roles

| Role | Capabilities |
|---|---|
| **Bank Admin** | Manage bank users, roles, policy filters, integration settings, disbursement accounts. |
| **Viewer / Analyst** | View eligible listings and full permitted data; run analysis; cannot create or approve offers. |
| **Offer Maker** | Create, revise, and submit an offer for internal approval; withdraw before acceptance. |
| **Offer Approver** | Approve or reject an offer created by another user. **MUST NOT** approve an offer they created. |
| **Operations** | Mark funding sent, generate funding OTP, record buyer payments, attach evidence, initiate recourse. |
| **Auditor** | Read-only across the bank's own records and reports; no write capability anywhere. |

`ZM-ROL-001` Maker/approver separation **MUST** be enforced for every published offer in V3.
`ZM-ROL-002` The system **MUST** reject any approval where `approvedByUserId == createdByUserId`.

#### 3.3.2 Supplier roles

| Role | Capabilities |
|---|---|
| **Supplier Owner / Admin** | Manage the organization, users, bank accounts, and consents; full visibility. |
| **Authorized Signatory** | Sign contracts on behalf of the supplier; must match or be authorized against registry signatories. |
| **Invoice Uploader** | Create submissions, resolve buyers, upload documents, set the minimum acceptable amount. |
| **Viewer** | Read-only. |

`ZM-ROL-003` A single user **MAY** hold multiple supplier roles simultaneously.
`ZM-ROL-004` Only an **Authorized Signatory** may sign; only an Owner/Admin or Uploader may accept an offer, per `CONFIGURABLE` policy. `ASSUMPTION` — default: offer acceptance requires Owner/Admin.

#### 3.3.3 Platform roles

| Role | Capabilities |
|---|---|
| **Super Admin** | Full system configuration, role management, policy versions, emergency controls. |
| **Operations Admin** | Marketplace operation, listings, relisting approvals, withdrawal cases, fee configuration. |
| **Supplier Reviewer** | Onboarding review, information requests, approval/rejection decisions. |
| **Compliance Officer** | Fraud cases, sanctions review, blacklisting, restriction decisions. |
| **Support Agent** | User assistance; read-mostly; no financial or decision authority. |
| **Platform Auditor** | Full read access to audit logs and reports; no write capability. |

#### 3.3.4 Multi-organization membership

`ZM-ROL-005` A `User` **MAY** hold memberships in multiple organizations (many-to-many `OrganizationMembership`).
`ZM-ROL-006` The user **MUST** operate within exactly one **active organization context** at a time.
`ZM-ROL-007` All permissions, queries, and data access **MUST** be scoped to the active context; cross-context data leakage is a critical defect.
`ZM-ROL-008` Every audit entry **MUST** record both `actorUserId` and `actorOrganizationId` (the active context).
---

## 4. System Scope and Module Map

### 4.1 V3 release scope

The competition release delivers the **complete internal platform**. External dependencies (government registries, settlement, signatures, messaging) run through **adapters** with dummy/sandbox implementations, but every internal workflow **MUST** genuinely function end to end.

**In scope:** authentication; roles and permissions; multi-org context; supplier onboarding with SLA; government verification workflow; buyer resolution; invoice submission; document storage; OCR; QR extraction; verification checks; duplicate detection; fraud review; Trust Score with real ML; bank onboarding with demo organizations and real user accounts; policy filters and eligibility; marketplace listings; confidential offers; maker/approver approval; supplier offer comparison and selection; atomic invoice locking; offer conditions; contract generation and electronic signature; funding settlement; cross-party OTP; listing fee; platform commission; supplier payout tracking; buyer-to-bank payment status tracking; partial payment; overdue tracking; recourse; disputes; withdrawal cases; notifications with delivery evidence; administration; compliance; immutable audit logs; reports; bilingual EN/AR with RTL; demo time machine.

**Out of scope for V3:** post-dated cheques and any handover process; native mobile applications; buyer portal of any kind; real production government API integration; real regulated fund custody; production PKI; multi-currency; secondary market or invoice resale; automatic relisting.

### 4.2 Module codes

| Code | Module |
|---|---|
| `IAM` | Identity, Access, and Organizations |
| `SON` | Supplier Onboarding |
| `GOV` | Government Verification |
| `BUY` | Buyer Directory and Resolution |
| `INV` | Invoice Submission and Management |
| `DOC` | Document Storage, OCR, and QR |
| `VER` | Verification and Duplicate Detection |
| `RSK` | Risk, Trust Score, and ML |
| `MKT` | Marketplace and Listings |
| `OFR` | Bank Offers and Conditions |
| `SEL` | Offer Selection and Locking |
| `CON` | Contracts and Signatures |
| `FND` | Funding, OTP, and Settlement |
| `FEE` | Fees, Commission, and Ledger |
| `PMT` | Post-Funding Payment Tracking |
| `REC` | Recourse, Disputes, Withdrawal |
| `FRD` | Fraud and Compliance |
| `NOT` | Notifications |
| `AUD` | Audit, Reporting, Administration |
| `I18N` | Internationalization |
| `DEMO` | Demo and Test Tooling |

---

## 5. Supplier Onboarding

### 5.1 Principle

`ZM-SON-001` The supplier **MUST** provide only the minimum data that cannot be obtained from a government source.
`ZM-SON-002` The platform **MUST** retrieve all available registry data automatically.
`ZM-SON-003` Government-sourced values **MUST NOT** be editable by any user, including administrators. Corrections are made by re-querying the source.
`ZM-SON-004` Supplier-provided values **MUST** be stored as `SELF_DECLARED` with evidence and a verification status, and **MUST NOT** overwrite a government-sourced value for the same field.

### 5.2 Data entered by the supplier

| Stage | Fields | Purpose |
|---|---|---|
| Account creation | Phone, email, password | Login, OTP, notifications |
| Business identification | National establishment number; profession licence number | Registry lookup keys |
| User identity | National ID of the account user | Match against authorized signatories |
| Disbursement | IBAN, bank name, account-holder name, ownership evidence | Ensure payout reaches the correct business account |
| Consents | Lookup and sharing authorization; terms; privacy; declarations | Enable verification and bank disclosure |

`ZM-SON-005` The platform **MUST NOT** ask the supplier to type: company name, legal type, status, registration date, registered address, capital, partners, authorized signatories, business purposes, or tax number. These are derived.

### 5.3 Data retrieved automatically

| Source | Key | Retrieved |
|---|---|---|
| Companies Control Department (CCD) | National establishment number | Name, company number, type, status, registration and modification dates, address, registered contacts, capital, authorized signatories, purposes, partners, management, announcements |
| Income and Sales Tax Department (ISTD) | National establishment number | Tax number, registration status, registered name (subject to availability) |
| Greater Amman Municipality / licensing authority (GAM) | Establishment number + profession licence number | Licence status, activity, address, issue and expiry dates (subject to availability) |

`ZM-GOV-001` Every lookup **MUST** persist a raw `GovernmentDataSnapshot` (verbatim source payload) **and** a normalized result object.
`ZM-GOV-002` Every field **MUST** carry: `value`, `source`, `retrievedAt`, `verificationStatus`, `evidenceRef`, `sourceReference`.
`ZM-GOV-003` Registry results are explicitly **preliminary and possibly incomplete**. Blank fields are normal and **MUST NOT** be treated as adverse.

### 5.4 Verification sequence

1. Account created; phone and email verified.
2. Supplier enters establishment number and licence number, and grants lookup authorization.
3. Platform queries CCD; snapshot and retrieval timestamp persisted.
4. Company status checked; core name and registration identifiers matched.
5. ISTD queried; tax number retrieved; registered name matched.
6. GAM queried; licence status, activity, and address checked.
7. Account user compared against authorized signatories; if absent, authorization evidence requested.
8. IBAN and account ownership verified.
9. Automated screening completed, then human review.
10. Decision issued: approval, conditional approval, information request, or rejection.

### 5.5 Application states and the 24-business-hour SLA

| State | Meaning | SLA clock |
|---|---|---|
| `DRAFT` | Not yet submitted | Not started |
| `SUBMITTED` | Application submitted | **Starts** |
| `AUTOMATED_VERIFICATION` | Registry checks running | Running |
| `UNDER_REVIEW` | Human reviewer assessing | Running |
| `INFORMATION_REQUIRED` | Awaiting supplier input | **Paused** |
| `INFORMATION_RESUBMITTED` | Supplier responded | **Resumes** |
| `GOVERNMENT_SERVICE_UNAVAILABLE` | Source unavailable | **Paused** |
| `FINAL_REVIEW` | Decision review | Running |
| `APPROVED` / `APPROVED_CONDITIONAL` / `REJECTED` | Decided | **Stops** |

`ZM-SON-006` Target: a decision within **24 business hours** after the file is complete and required government services are available.
`ZM-SON-007` Business calendar defaults (`CONFIGURABLE`): **Sunday–Thursday, 08:00–17:00, Asia/Amman**, with a configurable public-holiday calendar.
`ZM-SON-008` Every pause and resume **MUST** be recorded with timestamp, reason, and actor, so elapsed business time is fully reconstructible.
`ZM-SON-009` The supplier **MUST** see remaining SLA time and current state at all times.

### 5.6 Missing information handling

| Case | System action | Request to supplier |
|---|---|---|
| Optional field absent | No effect on decision | None, or optional completion |
| Essential field absent | `INFORMATION_REQUIRED` | Provide value + evidence |
| Authorized signatory absent | Suspend activation | Recent signatory certificate or authorization |
| Beneficial owner unavailable | Separate request when required | Ownership declaration + evidence |
| Licence not found | Review or correction request | Correct number or current copy |
| Bank account mismatch | Mandatory manual review | Ownership evidence or corrected account |

`ZM-SON-010` Government-service downtime **MUST NOT** reduce any reliability indicator and **MUST NOT** cause rejection.

### 5.7 Decision outcomes

| Outcome | Conditions | Result |
|---|---|---|
| **Approval** | Active company; tax, licence, signatory, and bank account verified; no hard blocker | `APPROVED` → `ACTIVE` |
| **Conditional approval** | Non-material operational item outstanding | `APPROVED_CONDITIONAL`; account accessible, **financing actions disabled** until conditions cleared |
| **Information request** | Essential data missing or correctable mismatch | `INFORMATION_REQUIRED` |
| **Rejection** | Hard-rejection condition, fraud, or business cannot be established | `REJECTED` with a structured `reasonCode` |

`ZM-SON-011` Under `APPROVED_CONDITIONAL`, the supplier **MUST** be able to log in, view the platform, and complete outstanding items, but **MUST NOT** create invoice submissions or listings.

### 5.8 Hard-rejection rules

`ZM-SON-012` The following **MUST** produce rejection:

- Company suspended, struck off, or not found.
- Company in liquidation or insolvency, subject to the approved legal and credit policy. `LEGAL_TBD_POST_COMPETITION` — **LT-02.** Treatment of liquidation. **Technical assumption:** configurable policy; default is manual review escalating to rejection.
- Profession licence suspended or cancelled, or activity prohibited.
- Forgery, manipulation, or impersonation of an authorized signatory.
- Refusal of essential consents, or inability to establish ownership of the bank account.
- Confirmed legal prohibition or mandatory sanctions-list match.

`ZM-SON-013` **Sole proprietorships and entities that cannot be verified** through CCD or a supported licensing authority are **not eligible** in V3. The platform **MUST** display a clear, non-pejorative ineligibility message and record the attempt.

### 5.9 Snapshot freshness and re-verification

`ZM-GOV-004` A government snapshot is considered current for **90 days** (`CONFIGURABLE`).
`ZM-GOV-005` The platform **MUST** re-query when a new invoice is submitted and the most recent relevant snapshot is older than the freshness window.
`ZM-GOV-006` V3 **MUST NOT** run scheduled background re-verification sweeps. Re-verification is **activity-triggered** only.
`ZM-GOV-007` If a re-check reveals the supplier has become suspended or struck off, the platform **MUST**: suspend or restrict the account; block new invoice submissions; preserve all existing transactions and financial records unchanged; notify administration and the supplier.

### 5.10 Government adapter contract

`ZM-GOV-008` Each source **MUST** be implemented behind a common adapter interface with dummy and production implementations, delivering:

- documented endpoints, request and response schemas, and status codes;
- **full**, **partial**, and **unavailable** response variants;
- deterministic seeded test data keyed by establishment number;
- simulated latency and configurable failure injection;
- authentication placeholders;
- retry, timeout, and circuit-breaker behaviour;
- raw snapshot persistence plus normalized output;
- a `sourceAvailability` signal distinguishing *"source said no"* from *"source did not answer"*.

`ZM-GOV-009` Replacing a dummy adapter with a production adapter **MUST NOT** require any change to core domain logic.

> `LEGAL_TBD_POST_COMPETITION` — **LT-03.** Permissible storage, sharing, reuse, and retention of government-sourced data, and whether supplier consent covers onward disclosure to banks. **Technical assumption:** consent recorded per purpose and version; snapshots retained; disclosure to banks gated by policy.

---

## 6. Bank Onboarding and Policy Configuration

### 6.1 Bank institution data

`ZM-IAM-001` A bank organization record **MUST** capture: legal name, licence number, contact details, signed platform agreement reference, authorized administrators, disbursement and collection account details, and integration configuration.

### 6.2 Bank states

`INVITED → ONBOARDING → UNDER_REVIEW → ACTIVE → SUSPENDED → TERMINATED`

`ZM-IAM-002` Only an `ACTIVE` bank may be evaluated for listing eligibility or submit offers.

### 6.3 Bank policy filters

`ZM-MKT-001` Each bank **MUST** be able to configure policy filters that determine which listings it is eligible to see:

| Filter | Type |
|---|---|
| Sector / activity | Include / exclude list |
| Minimum and maximum invoice amount | Range |
| Tenor (days to maturity) | Range |
| Accepted `transactionType` values | Set |
| Recourse appetite | Set of `recourseType` |
| Minimum composite Trust Score | Threshold |
| Maximum risk band | Enum ceiling |
| Required document types | Set |
| Buyer restrictions | Include / exclude list |
| Supplier restrictions | Include / exclude list |
| Geography / governorate | Include / exclude list |

`ZM-MKT-002` Eligibility **MUST** require **both** conditions: (a) the bank is active and permitted by platform administration, **and** (b) the listing matches the bank's configured filters.
`ZM-MKT-003` Every eligibility evaluation **MUST** be persisted with its outcome and the specific rules applied, so a bank can be shown why it did or did not receive a listing.

---

## 7. Buyer Directory and Resolution

### 7.1 Buyer as a global entity

`ZM-BUY-006` `Buyer` **MUST** be a **global, platform-wide entity**, uniquely keyed by national establishment number.
`ZM-BUY-007` Multiple suppliers and multiple invoices **MUST** be able to reference the same `Buyer` record.
`ZM-BUY-008` Supplier-specific contact and relationship data **MUST** live on `SupplierBuyerRelationship`, never on `Buyer`.

### 7.2 Data requested from the supplier

| Field | Requirement | Use |
|---|---|---|
| Buyer establishment name | Required | Registry search |
| Buyer contact number | Required | Future communication |
| Contact-person name | Required | Identify the number's owner |
| Contact-person role | Required | Accountant, purchasing, manager, owner, other |
| Contact email | Optional | Notification channel |
| Receiving branch | When applicable | Link invoice to correct location |

### 7.3 Resolution workflow

1. Search buyers already linked to this supplier.
2. If none, search buyers already known to the platform.
3. If still none, query CCD by name via the government adapter.
4. Display candidate results: name, type, national number, status, governorate.
5. **The supplier selects the exact buyer** and confirms it is the entity named on the invoice.
6. Platform matches national number, name, and available invoice data.
7. Retrieve the full company profile for the confirmed national number.
8. Create or link the unified `Buyer` record.
9. Create or update the `SupplierBuyerRelationship` with contact data.

`ZM-BUY-009` The platform **MUST NOT** automatically select a buyer based on name similarity alone, under any circumstances.
`ZM-BUY-010` Ambiguous, multiple, or unclear results **MUST** move to `BUYER_MANUAL_REVIEW`.

### 7.4 Buyer verification states and invoice effect

| Buyer state | Effect on invoice |
|---|---|
| `ACTIVE` + `MATCHED` | Proceed |
| `ACTIVE` + `PARTIAL_MATCH` | Manual review or clarification |
| `NOT_FOUND` | Manual review; alternative lookup key |
| `NAME_MISMATCH` / `ID_MISMATCH` | **Blocked** until resolved |
| `SUSPENDED` | **Blocked** |
| `STRUCK_OFF` | **Blocked** |
| `UNDER_LIQUIDATION` | **Manual review** — see LT-02 |

### 7.5 Buyer contact data

`ZM-BUY-011` Contact data is stored as **supplier-provided**, explicitly not as the buyer's official registry contact.
`ZM-BUY-012` Contact states: `SUPPLIER_PROVIDED`, `UNVERIFIED`, `CONTACTED`, `VERIFIED_BY_CONTACT`, `INVALID`, `DO_NOT_CONTACT`.
`ZM-BUY-013` The originating supplier and every subsequent update **MUST** be recorded with actor and timestamp.
`ZM-BUY-014` `DO_NOT_CONTACT` **MUST** suppress all outbound notification to that contact, across all suppliers, permanently until explicitly reversed by an administrator with a recorded reason.
`ZM-BUY-015` The platform **MUST** collect only contact data necessary for the transaction, restrict access by role, protect sensitive fields at rest, audit every access and update, and support correction and invalidation.

---

## 8. Invoice Submission

### 8.1 Required invoice data

| Group | Fields |
|---|---|
| Identification | Invoice number; electronic-invoice identifier; issue date |
| Parties | Registered supplier; resolved buyer; branch when applicable |
| Value | Subtotal; tax; total (`faceValue`); currency; `paidAmount`; `outstandingAmount` |
| Maturity | Due date; payment terms; payment period |
| Trade documents | Goods/services description; purchase-order number; delivery-note number when available |
| Financing | `minimumAcceptableAmount`; disclosure of any related previous financing |

`ZM-INV-001` `outstandingAmount = faceValue − paidAmount`, and **MUST** be greater than zero for an invoice to be listed.
`ZM-INV-002` Currency **MUST** be stored as an ISO 4217 code; the only accepted value in V3 is **`JOD`**. Invoice, offer, settlement, commission, and payout currencies **MUST** all match.
`ZM-INV-003` All monetary values **MUST** be stored as `numeric(18,3)` and computed with decimal arithmetic. Floating-point arithmetic on money is prohibited.

### 8.2 Documents

`ZM-DOC-001` An **electronic invoice is mandatory** for every submission in V3. A submission without one cannot proceed.
`ZM-DOC-002` Delivery note, purchase order, statement of account, and any credit note, return, or adjustment are **mandatory or conditional** per bank or platform policy (`CONFIGURABLE`).
`ZM-DOC-003` Every document **MUST** store a content hash, MIME type, size, uploader, and upload timestamp.
`ZM-DOC-004` Documents **MUST** be held in private storage; access **MUST** be by short-lived signed URL issued only after a server-side authorization check.

### 8.3 OCR and QR extraction

`ZM-DOC-005` OCR **MUST** perform **both** functions:
   (a) **pre-fill** structured invoice fields for supplier review and correction;
   (b) **cross-validate** extracted values against supplier-confirmed values and raise mismatches.
`ZM-DOC-006` Both the original OCR output **and** the supplier's corrections **MUST** be preserved and independently retrievable. A supplier correction **MUST NOT** erase the machine-extracted value.
`ZM-DOC-007` The platform **MUST** decode and parse the QR code on the Jordanian electronic invoice locally.
`ZM-DOC-008` QR-derived values **MUST** be compared against OCR output and supplier-entered fields; each comparison result **MUST** be recorded as a `VerificationCheck`.
`ZM-DOC-009` The platform **MUST** call a **dummy government e-invoice validation adapter**, replaceable later by a real validation service without core changes.
`ZM-DOC-010` The system **MUST NOT** hard-code an undocumented official QR payload structure. Parsing **MUST** be schema-driven and tolerant of format variation, degrading to "unparsed — manual review" rather than failing loudly or guessing.

### 8.4 Supplier declarations

`ZM-INV-004` For every invoice the supplier **MUST** affirm, with the declaration text version recorded:

- The invoice is authentic and represents a real commercial transaction.
- The goods or services were delivered per the commercial relationship.
- The invoice is unpaid and not cancelled.
- No known dispute, return, or undisclosed discount exists.
- The invoice has not previously been sold, assigned, pledged, or financed.
- The selected buyer is the entity named on the invoice.
- The contact details belong to a buyer representative the supplier actually uses.
- The supplier accepts recourse and indemnification for false declarations, as set out in the contract.

> `LEGAL_TBD_POST_COMPETITION` — **LT-04.** Enforceability and precise wording of the supplier declarations and indemnity. **Technical assumption:** declaration text is a versioned template; the accepted version is stored per submission.

### 8.5 Automated checks

| Check | Detail | Outcomes |
|---|---|---|
| Completeness | Required fields, documents, dates, values | `PASS` / `MISSING` |
| Identity match | Supplier and buyer vs. invoice content | `MATCH` / `MISMATCH` |
| Duplicate detection | Fingerprint over parties, invoice number, date, value, tax | `UNIQUE` / `DUPLICATE` |
| Transaction logic | Maturity sanity, amount, currency, negatives, modifications | `PASS` / `REVIEW` |
| Party eligibility | Supplier and buyer status; exposure limits | `ELIGIBLE` / `BLOCKED` |
| File integrity | Hash, MIME type, visible modification indicators | `PASS` / `FRAUD_REVIEW` |
| OCR consistency | Extracted vs. confirmed values | `PASS` / `MISMATCH` |
| QR consistency | QR vs. OCR vs. confirmed values | `PASS` / `MISMATCH` / `UNPARSED` |

`ZM-VER-001` The active-invoice **fingerprint MUST be unique** platform-wide. A collision **MUST** block submission and open a review record.
`ZM-VER-002` A failed check **MUST NOT** by itself be treated as proven fraud. It routes to review.

### 8.6 Pre-market invoice states

`DRAFT → SUBMITTED → AUTOMATED_CHECKS → UNDER_REVIEW → INFORMATION_REQUIRED → ELIGIBLE | REJECTED | FRAUD_REVIEW`

`ZM-INV-005` `ELIGIBLE` means verification passed and the invoice may be listed. It does **not** imply any financing commitment.
---

## 9. Risk, Trust Score, and Machine Learning

### 9.1 Purpose and limits

`ZM-RSK-001` The Trust Score is **decision support only**. It **MUST NOT** be presented as a guarantee, a credit rating, or a substitute for the bank's own credit decision.
`ZM-RSK-002` Every score display **MUST** carry a plain-language disclaimer to this effect, in both languages.

### 9.2 Structure

`ZM-RSK-003` The platform **MUST** produce both:

- a **composite Trust Score**, numeric **0–100**; and
- a **risk band**: `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`.

`ZM-RSK-004` The platform **MUST** also produce five component indicators:

| Indicator | Measures | Example inputs |
|---|---|---|
| **Supplier Verification** | Completeness and reliability of the supplier profile | Registry status, licence, tax, signatory match, bank account verification |
| **Data Confidence** | Strength and freshness of underlying sources | Government vs. verified self-declared vs. unverified vs. conflicting; snapshot age |
| **Buyer Profile** | Available information about the debtor | Status, company age, activity, capital, platform payment history |
| **Invoice Score** | Invoice integrity and eligibility | Completeness, matching, uniqueness, evidence quality, tenor |
| **Platform Behavior** | Supplier conduct on the platform | Prior invoices, disputes, duplicates, recourse history, compliance events |

### 9.3 The data-availability rule

`ZM-RSK-005` **Government service downtime, an unavailable source, or a field the source does not publish MUST NEVER reduce the Trust Score.**
`ZM-RSK-006` Such conditions **MUST** instead reduce a separate `dataAvailability` measure, and where the field is essential, raise an `InformationRequest`.
`ZM-RSK-007` What **does** materially affect the score or trigger rejection: refusal to supply essential information, internal contradictions in supplied data, forged or manipulated evidence, and confirmed adverse registry status.
`ZM-RSK-008` The distinction between *"the source reported adverse information"* and *"the source did not respond"* **MUST** be preserved structurally at every layer, from adapter to score to UI.

### 9.4 Versioning

`ZM-RSK-009` Scoring weights and rules **MUST** be administrator-configurable, but changes **MUST** create a **new `RiskModelVersion`**, never edit an active version in place.
`ZM-RSK-010` Every calculated score **MUST** permanently retain the version identifier used, and historical scores **MUST NOT** change when a new version is activated.
`ZM-RSK-011` Activation of a new version **MUST** be an auditable administrative action with actor, timestamp, and rationale.

### 9.5 Bank-facing disclosure

`ZM-RSK-012` An eligible bank **MUST** see: composite score; the five component scores; risk band; data-confidence level; positive factors; risk factors; structured reason codes; score version; calculation date.
`ZM-RSK-013` Banks **MUST NOT** receive raw model internals, feature weights, proprietary implementation details, or any hidden sensitive field.

### 9.6 Machine learning requirements

`ZM-RSK-014` V3 **MUST** include a **real, executable ML training and inference pipeline** — not a stub.
`ZM-RSK-015` The architecture **MUST** separate two concerns:

- **Deterministic rules** govern hard eligibility and hard fraud blockers. An ML model **MUST NOT** be able to override a deterministic blocker.
- **A trained ML model** produces risk and anomaly estimation contributing to the score.

`ZM-RSK-016` Where real historical data is unavailable, the pipeline **MUST** use clearly labelled synthetic or demonstration training data, and the limitation **MUST** be disclosed in the UI and in reports.
`ZM-RSK-017` The pipeline **MUST** provide: model versioning; recorded training metrics; per-prediction explainability (contributing features and direction); and a graceful fallback to rules-only scoring when the model service is unavailable, with the degraded mode visibly flagged.
`ZM-RSK-018` Document-forgery detection **MAY** begin with deterministic integrity checks and anomaly features. It **MUST NOT** be presented, labelled, or described as production-grade forensic detection.

---

## 10. Marketplace and Listings

### 10.1 Listing creation

`ZM-MKT-004` Only an `ELIGIBLE` invoice may be listed.
`ZM-MKT-005` At listing activation the platform **MUST**: evaluate eligibility for every active bank; notify eligible banks; open the offer window; and create the **listing-fee obligation** (§12.2).
`ZM-MKT-006` The invoice enters `OPEN_FOR_OFFERS`.

### 10.2 Deadlines

`ZM-MKT-007` Two deadlines govern a listing:

| Deadline | Default (`CONFIGURABLE`) | Measured from |
|---|---|---|
| `offerSubmissionDeadline` | **24 hours** | Listing activation |
| `supplierSelectionDeadline` | **12 hours** | Close of offer submission |

`ZM-MKT-008` Defaults are set by platform administration. **The supplier MUST NOT choose arbitrary deadlines in V3.**
`ZM-MKT-009` The offer window **MUST** close automatically at `offerSubmissionDeadline`. No offer, revision, or withdrawal is accepted afterwards.
`ZM-MKT-010` The platform **MUST** send reminders before the supplier-selection deadline (`CONFIGURABLE`; `ASSUMPTION` — default at 50% and 15% of remaining time).

### 10.3 Confidentiality

`ZM-MKT-011` A bank **MUST NOT** be able to see, infer, or derive: another bank's identity as a participant; another bank's offered amount; another bank's fees; another bank's conditions; or the total number of competing offers.
`ZM-MKT-012` The supplier's `minimumAcceptableAmount` **MUST NOT** be disclosed to any bank, in any form, including through validation error messages or UI hints.
`ZM-MKT-013` Only the supplier may compare all active offers.

> **Design note.** `ZM-MKT-012` has a concrete implementation consequence: when a bank submits an offer whose net payout falls below the supplier's floor, the rejection message **MUST NOT** reveal the floor or the shortfall. It states only that the offer does not currently meet the supplier's requirements.

### 10.4 Bank-visible data

`ZM-MKT-014` An eligible bank **MUST** see the **verified legal identity** of both supplier and buyer, because it cannot underwrite otherwise: company identity, registration details, status, permitted invoice data, permitted documents, Trust Score and indicators, and policy-permitted transaction history.
`ZM-MKT-015` Personal data **MUST** be minimized and role-restricted. Banks see only the personal, signatory, and contact data necessary for underwriting and contracting.

> `LEGAL_TBD_POST_COMPETITION` — **LT-05.** Lawful basis and consent scope for disclosing supplier, signatory, and buyer personal data to banks. **Technical assumption:** disclosure gated by a versioned consent record and a configurable field-level disclosure policy per recipient role.

### 10.5 Listing outcomes

| Outcome | Result |
|---|---|
| Supplier accepts an offer | Invoice locked; proceeds to contracting |
| Supplier rejects all offers | Invoice returns to `ELIGIBLE` |
| Selection deadline lapses | Active offers expire; listing closes; invoice returns to `ELIGIBLE` |
| No offers received | Listing closes; invoice returns to `ELIGIBLE` |

`ZM-MKT-016` **Relisting is never automatic.** It requires a manual request and platform verification that: the invoice is still unpaid; has not already been financed; has not been cancelled or materially changed; has not expired; and both supplier and buyer remain eligible.
`ZM-MKT-017` Each relisting round **MAY** incur a further listing fee per `CONFIGURABLE` policy.

---

## 11. Bank Offers

### 11.1 Offer content

`ZM-OFR-001` A `BankOffer` **MUST** contain:

**Classification**

| Field | Values |
|---|---|
| `transactionType` | `INVOICE_FINANCING`, `RECEIVABLE_PURCHASE`, `RECEIVABLE_ASSIGNMENT`, `OTHER` |
| `recourseType` | `FULL_RECOURSE`, `LIMITED_RECOURSE`, `NON_RECOURSE`, `OTHER` |

**Money**

| Field | Meaning |
|---|---|
| `grossFundingAmount` | Total the bank commits against the receivable |
| `bankDiscountAmount` | Bank's discount |
| `bankFeesAmount` | Bank's fees and charges |
| `platformCommissionAmount` | Zimmamless success commission |
| `listingFeeAmount` | Listing fee applied to this transaction (unpaid portion) |
| `otherDeductionsAmount` | Any other agreed deduction |
| `netSupplierPayout` | Computed result |

**Terms**

| Field | Meaning |
|---|---|
| `expectedPayoutDate` | Indicative funding date |
| `validUntil` | Offer expiry |
| `conditions[]` | Structured `OfferCondition` records |
| `versionNumber`, `previousOfferId` | Revision lineage |

### 11.2 The money formula

```
netSupplierPayout =
      grossFundingAmount
    − bankDiscountAmount
    − bankFeesAmount
    − platformCommissionAmount
    − unpaidListingFeeAmount
    − otherDeductionsAmount
```

`ZM-OFR-002` The supplier **MUST** be shown both the **full component breakdown** and the **single net figure**, side by side, before acceptance.
`ZM-OFR-003` The formula **MUST** be evaluated server-side with decimal arithmetic. Client-side computation is presentational only and **MUST** be re-verified on submission.

### 11.3 Amount constraints

`ZM-OFR-004` `minimumAcceptableAmount` is the **minimum net amount the supplier is willing to receive** — not a gross floor.

```
minimumAcceptableAmount  >  0
minimumAcceptableAmount  ≤  invoice.outstandingAmount
grossFundingAmount       ≤  invoice.outstandingAmount
netSupplierPayout        ≥  minimumAcceptableAmount
```

`ZM-OFR-005` Every constraint **MUST** be enforced server-side at offer submission, at offer revision, and again at acceptance.
`ZM-OFR-006` **Partial funding is permitted.** A bank may offer less than the full outstanding amount, provided the resulting net payout meets the supplier's floor.
`ZM-OFR-007` Once an offer is accepted, the invoice is locked in full. The remaining unfunded portion **MUST NOT** be separately listed in V3.

### 11.4 Transaction type behaviour

`ZM-OFR-008` All transaction types **MUST** share the same core lifecycle and marketplace workflow. `transactionType` **MUST NOT** create a separate state machine in V3.
`ZM-OFR-009` `transactionType` **MAY** select: a different contract template; different disclosure text; different required documents; different permitted bank conditions; a different default recourse configuration.
`ZM-OFR-010` `transactionType` is set **per offer**. A bank **MAY** define a default in its policy and **MAY** override it per offer.
`ZM-OFR-011` A supplier **MAY** legitimately be comparing offers of different transaction types simultaneously. The type and its plain-language explanation **MUST** be prominently displayed for each offer before selection.
`ZM-OFR-012` The supplier **MUST** see, for every offer, before accepting: transaction type; recourse type; gross amount; every deduction; net payout; all conditions; expected payout date; and offer validity.

> `LEGAL_TBD_POST_COMPETITION` — **LT-06.** The legal effect, contractual meaning, and enforceability of each `transactionType`, and of each `recourseType`. **Technical assumption:** each is an enum driving a template selection and a disclosure text block; no legal consequence is inferred by the system.

### 11.5 Offer lifecycle

`DRAFT → PENDING_INTERNAL_APPROVAL → ACTIVE → (REVISED)* → SELECTED | NOT_SELECTED | WITHDRAWN | EXPIRED`

`ZM-OFR-013` A bank has **exactly one current offer** per listing. Revisions supersede; every prior version is retained immutably.
`ZM-OFR-014` Offers **MUST** be submitted within the open window; submission outside it **MUST** be rejected with a clear reason.
`ZM-OFR-015` A bank **MAY withdraw an active offer before acceptance with no penalty.** The withdrawal is audited. The penalty regime (§16) applies **only after** acceptance.
`ZM-OFR-016` Maker/approver separation applies: an offer reaches `ACTIVE` only after approval by a different user holding the Offer Approver role.

### 11.6 Offer conditions

`ZM-OFR-017` `OfferCondition` types: `REQUIRED_GUARANTEE`, `REQUIRED_DOCUMENT`, `RECOURSE_TERM`, `FUNDING_TIMELINE`, `CONTRACTUAL_CONDITION`, `OTHER`.
`ZM-OFR-018` Each condition **MUST** carry: type, title, description, mandatory flag, display order, and a fulfilment status tracked through to contracting.
`ZM-OFR-019` `REQUIRED_POST_DATED_CHEQUE` is **removed** from the condition vocabulary in V3.

---

## 12. Offer Selection, Locking, and Fees

### 12.1 Selection and atomic locking

`ZM-SEL-001` The supplier **MAY accept an active offer at any time while the listing is open.** There is no requirement to wait for the submission deadline.
`ZM-SEL-002` Acceptance **MUST** execute atomically within a single database transaction that:

1. re-validates the offer is still `ACTIVE` and within `validUntil`;
2. re-validates `netSupplierPayout ≥ minimumAcceptableAmount`;
3. re-validates the invoice is still lockable and unmodified;
4. sets the invoice/transaction to locked;
5. marks the selected offer `SELECTED`;
6. marks every other active offer `NOT_SELECTED`;
7. creates the immutable `AcceptedOfferSnapshot`;
8. writes the audit entries.

`ZM-SEL-003` If any step fails, the entire transaction **MUST** roll back with no partial state.
`ZM-SEL-004` A second acceptance **MUST** be impossible. The lock **MUST** be enforced at the database level, not only in application logic.
`ZM-SEL-005` The platform **MUST NEVER** select an offer automatically, and **MUST NEVER** favour the highest amount. Selection is an explicit supplier act recording `selectedBy` and `selectedAt`.
`ZM-SEL-006` The selected offer is **not necessarily the highest** — the supplier legitimately weighs conditions, recourse type, transaction type, and timing against the amount.

### 12.2 The accepted offer snapshot

`ZM-SEL-007` `AcceptedOfferSnapshot` **MUST** freeze, immutably: bank identity; supplier identity; invoice reference; transaction type; recourse type; every money component; net payout; all accepted conditions; source offer version; selection timestamp; and a content hash.
`ZM-SEL-008` It **MUST** remain unchanged even if the source `BankOffer` record is later modified or superseded.

### 12.3 Listing fee

`ZM-FEE-001` The listing fee is **incurred when the marketplace listing becomes active**, regardless of whether financing ultimately succeeds.
`ZM-FEE-002` At listing activation the platform **MUST** create a **listing-fee obligation** record against the supplier.
`ZM-FEE-003` The listing fee is **separate and independent** from the success commission.
`ZM-FEE-004` If unpaid at payout time, the outstanding listing fee **MAY** be deducted from the supplier's net payout, appearing as `unpaidListingFeeAmount` in the offer breakdown.
`ZM-FEE-005` If no funding occurs, the listing fee **remains recorded as payable**.
`ZM-FEE-006` Fee amount, calculation basis, and relisting-fee policy **MUST** be `CONFIGURABLE`.
`ZM-FEE-007` The supplier **MUST** be shown the listing fee and its terms **before** confirming listing activation.

> `LEGAL_TBD_POST_COMPETITION` — **LT-07.** The legal mechanism for collecting, invoicing, and enforcing the listing fee, particularly where no funding occurs. **Technical assumption:** the obligation is recorded in the ledger as a receivable from the supplier; collection mechanics are adapter-driven and configurable.

### 12.4 Platform commission

`ZM-FEE-008` The commission fee-payer **MUST** be `CONFIGURABLE`: `SUPPLIER`, `BANK`, `SPLIT`, `CUSTOM`.
`ZM-FEE-009` The **V3 competition default is `SUPPLIER`** — the commission is deducted from the supplier's proceeds.
`ZM-FEE-010` The data model **MUST** support a separate bank-side fee even where the default is supplier-paid.
`ZM-FEE-011` Commission is calculated from `grossFundingAmount` using the `CommissionTier` active at calculation time. It **MUST NOT** be derived from `faceValue` or `minimumAcceptableAmount`.
`ZM-FEE-012` `CommissionCalculation` **MUST** store the applied percentage and applied fixed amount as a snapshot, so later tier changes never retroactively alter a completed calculation.

### 12.5 Commission recognition

`ZM-FEE-013` Commission becomes **final only on `SUPPLIER_PAYOUT_COMPLETED`.**
`ZM-FEE-014` It is **NOT** finalized when: the offer is accepted; the contract is signed; or the bank merely initiates funding.
`ZM-FEE-015` A finalized commission **MUST NEVER** be deleted or edited. Any reversal **MUST** be a **compensating entry** referencing the original.

---

## 13. Contracts and Signatures

### 13.1 Contract generation

`ZM-CON-001` The platform **MUST** generate the contract from a **template engine with structured merge fields**, populated from the `AcceptedOfferSnapshot` and verified party data.
`ZM-CON-002` A **template per `transactionType`** **MUST** be maintained, with a configurable default fallback template.
`ZM-CON-003` Templates **MUST** be versioned; the version used **MUST** be recorded on the contract.
`ZM-CON-004` The bank **MAY** attach additional documents or condition annexes.
`ZM-CON-005` A `ContractTermSnapshot` **MUST** freeze all terms at generation, with a content hash.

### 13.2 Pre-contract checks

`ZM-CON-006` Before contract generation the platform **MUST** confirm: the invoice has not changed, expired, or been cancelled; mandatory offer conditions are fulfilled or explicitly waived with a record; supplier declarations are reconfirmed; and the supplier bank account is verified.

### 13.3 Signature

`ZM-CON-007` Signature **MUST** operate through a **provider-agnostic `SignatureProvider` adapter**.
`ZM-CON-008` For the competition the platform **MUST** ship a dummy/sandbox provider supporting **in-platform click-to-accept**, recording: signer identity, organization, capacity, timestamp, IP address, device metadata, signed-document hash, and a complete audit trail.
`ZM-CON-009` A production PKI or qualified signature provider **MUST** be insertable later without core domain changes.
`ZM-CON-010` Default signature requirement: **one authorized supplier signatory and one authorized bank signatory**. The data model **MUST** support multiple required signatories per organization.
`ZM-CON-011` A signature counts only after `SignatureVerification` confirms document integrity, signer identity, and signer authority.
`ZM-CON-012` The contract becomes `FULLY_SIGNED` only when every required verified signature is present.

### 13.4 Zimmamless as a party

`ZM-CON-013` Zimmamless **does not sign** the bank–supplier receivable contract in the V3 technical model.
`ZM-CON-014` Platform fees and usage terms are accepted through a **separate platform agreement / terms acceptance**, versioned and recorded per organization.

> `LEGAL_TBD_POST_COMPETITION` — **LT-08.** Contractual wording of every template; enforceability of click-to-accept signature; whether Zimmamless must be a contract party to charge its fee; and whether any registration, assignment, or perfection step is legally required. **Technical assumption:** two-party contract; separate platform terms; the data model retains an `AssignmentRecord` placeholder for future perfection evidence.

### 13.5 Prior rights and perfection

`ZM-CON-015` Zimmamless **does not perform** prior-right checks or legal perfection. These remain entirely with the bank.
`ZM-CON-016` The platform **MAY** record bank-supplied evidence of any perfection step for completeness.

> `LEGAL_TBD_POST_COMPETITION` — **LT-09.** Whether legal perfection or registration of assignment is required in Jordan, and who bears responsibility. **Technical assumption:** bank responsibility; platform records evidence only.

### 13.6 Double-financing control

`ZM-CON-017` An invoice in `OFFER_ACCEPTED`, `CONTRACTED`, `FUNDING_CONFIRMATION_PENDING`, or `FUNDED` **MUST NOT** be re-uploaded or re-listed.
`ZM-CON-018` This is a **platform-internal control only**. It does not replace the bank's own prior-rights checks or any legal perfection outside Zimmamless, and the UI **MUST** say so plainly to banks.
---

## 14. Funding, Cross-Party OTP, and Settlement

### 14.1 What the OTP is for

The V3 OTP is **not** related to the removed cheque handover. It serves a different purpose entirely.

`ZM-FND-001` The funding OTP confirms **two things simultaneously**:
   (a) the **bank** has marked the funding transfer as executed; and
   (b) the **supplier** acknowledges the funding confirmation and participates in the final platform confirmation.

`ZM-FND-002` Its function is to **prevent the bank from unilaterally moving the transaction to `FUNDED`.** A bank-only confirmation would be one-sided; the OTP creates evidence that both parties participated.

### 14.2 Funding sequence

1. Contract is `FULLY_SIGNED`; all mandatory conditions are fulfilled.
2. Supplier bank account is verified; `CommissionCalculation` is prepared.
3. Bank executes or confirms the funding transfer.
4. Authorized bank user clicks **Funding Sent** in the Zimmamless bank portal.
5. Bank user **generates the OTP** in the portal.
6. Bank communicates the OTP to the supplier through their agreed channel, at a coordinated time.
7. Supplier enters the OTP into Zimmamless.
8. Platform validates the OTP.
9. Platform checks settlement/payment evidence.
10. **Both** OTP confirmation **and** settlement evidence being satisfied, the transaction becomes `FUNDED`.

`ZM-FND-003` **Both** conditions are required. OTP alone does not produce `FUNDED`; settlement evidence alone does not produce `FUNDED`.

### 14.3 OTP rules

`ZM-FND-004` The funding OTP is **mandatory for every V3 transaction**. The architecture **MUST** keep it configurable for future policy change.
`ZM-FND-005` The OTP **MUST** be: single-use; time-limited; stored only as a secure hash; bound to one specific transaction; bound to the issuing bank user; and fully audited.
`ZM-FND-006` Defaults (`CONFIGURABLE`):

| Parameter | Default |
|---|---|
| Validity | **15 minutes** |
| Maximum verification attempts | **5** |
| Maximum resends | **3** |
| Single use | Yes |
| Storage | Hash only |

`ZM-FND-007` Every OTP creation, resend, failed attempt, successful validation, and expiry **MUST** be audited with actor, timestamp, and IP.
`ZM-FND-008` The OTP is explicitly **not** a digital signature and carries **no** legal signing authority. Its sole purpose is cross-party synchronization of the funding confirmation event.
`ZM-FND-009` Failed attempts **MUST** be rate-limited and **MUST NOT** reveal whether the entered code was close, wrong, expired, or already used beyond a single generic failure message plus remaining-attempt count.

### 14.4 Pending confirmation

`ZM-FND-010` Between "Funding Sent" and successful OTP validation, the transaction sits in **`FUNDING_CONFIRMATION_PENDING`**.
`ZM-FND-011` While pending, the platform **MUST**: send reminders to the supplier; permit OTP regeneration by the bank; **escalate to platform administration after 24 hours** (`CONFIGURABLE`); **NOT** mark the invoice `FUNDED`; and **NOT** finalize the commission.
`ZM-FND-012` The transaction **MUST NOT** stall silently. Escalation creates an administrative task with full context.

### 14.5 Settlement architecture

`ZM-FND-013` The technical settlement model is:

```
Bank
  → Zimmamless settlement workflow (via configurable SettlementProvider adapter)
    → platform commission calculated and withheld
    → unpaid listing fee withheld
      → net supplier payout
```

`ZM-FND-014` The system **MUST** record three distinct financial legs: **gross bank funding**, **Zimmamless deductions** (commission + listing fee + other), and **net supplier payout**.
`ZM-FND-015` The platform **MUST** use a **provider-neutral `SettlementProvider` adapter** with dummy and production implementations. No provider name appears in the core domain model.
`ZM-FND-016` The architecture **MUST NOT** assume Zimmamless may hold customer funds in an ordinary operating account.

> `LEGAL_TBD_POST_COMPETITION` — **LT-10.** Whether routing funds through the platform requires a Central Bank of Jordan payment-service licence; whether funds may pass through a controlled account or must use a licensed provider performing split settlement. **Technical assumption:** an abstract settlement adapter with explicit split-settlement support, so the final licensed structure can be inserted without redesign.

### 14.6 Payout failure

`ZM-FND-017` If the bank funds the settlement but the supplier payout fails, the settlement enters **`PAYOUT_FAILED`** and the platform **MUST**:

- retry automatically a limited, configurable number of times with backoff;
- escalate to manual review if retries are exhausted;
- **NOT** mark the invoice `FUNDED`;
- **NOT** finalize the commission;
- guarantee **no duplicate payout** can occur under any retry or concurrency condition;
- audit every attempt with provider reference and failure reason.

`ZM-FND-018` Idempotency **MUST** be enforced on every settlement instruction using a stable idempotency key, so a retried or duplicated instruction cannot move money twice.
`ZM-FND-019` If a completed commission later requires reversal, the system **MUST** create a **compensating reversal entry**, never delete or edit the original record.

### 14.7 Ledger

`ZM-FEE-016` The platform **MUST** operate a **double-entry ledger** for all platform-controlled financial legs: listing fees; platform commissions; gross funding settlement; supplier payout; reversals; and recourse settlement where routed through the platform.
`ZM-FEE-017` Every ledger entry **MUST** be immutable and append-only. Corrections are made by compensating entries.
`ZM-FEE-018` Operational records of **bank-reported buyer collection MUST** be linked to reconciliation records and **MUST NOT** imply that Zimmamless ever held those funds. The ledger must make this distinction structurally obvious.
`ZM-FEE-019` The ledger **MUST** balance at all times; an out-of-balance condition is a critical alert.

---

## 15. Post-Funding Tracking

### 15.1 Continued involvement

`ZM-PMT-001` Zimmamless **MUST** continue tracking the receivable after funding. Platform involvement does **not** end at disbursement.

The lifecycle continues:

```
FUNDED
  → PARTIALLY_PAID
  → PAID
  → OVERDUE_UNCONFIRMED
  → OVERDUE
  → RECOURSE / DISPUTE
  → CLOSED
```

`ZM-PMT-002` Rationale, all of which are product requirements: monitor the receivable lifecycle; maintain accurate outstanding balances; improve future Trust Scores with real payment history; build platform-wide buyer payment-behaviour data; and support the overdue, recourse, dispute, and fraud workflows.

### 15.2 Buyer collection is external

`ZM-PMT-003` At maturity the buyer pays the **selected bank directly**.
`ZM-PMT-004` Zimmamless **MUST NOT**: execute the payment; hold the money; route the money; or guarantee collection.
`ZM-PMT-005` The bank reports payment through an API or authorized manual entry; Zimmamless records and reconciles the reported status.

### 15.3 Maturity monitoring

`ZM-PMT-006` The platform **MUST** send maturity notifications at **30, 14, and 7 days** before the due date, on the due date, and thereafter per policy (`CONFIGURABLE`).
`ZM-PMT-007` A scheduled job **MUST** monitor maturity dates continuously.

### 15.4 The unconfirmed-overdue distinction

`ZM-PMT-008` If the due date passes with no full payment reported, the transaction **MUST** become **`OVERDUE_UNCONFIRMED`** — not `OVERDUE`.
`ZM-PMT-009` The bank **MUST** be notified and asked to confirm the actual payment status.
`ZM-PMT-010` After bank confirmation the transaction resolves to `PAID`, `PARTIALLY_PAID`, or `OVERDUE`.
`ZM-PMT-011` **The absence of a bank report MUST NEVER be treated as proven default.** This distinction must be preserved in the data model, the UI, and every report and score input.

### 15.5 Recording payment

`ZM-PMT-012` An authorized bank user records: payment amount, date, provider or bank reference, and evidence.
`ZM-PMT-013` The platform reconciles cumulative payments against the receivable and recalculates the outstanding balance.
`ZM-PMT-014` Full payment → `PAID`, then `CLOSED` with `closureReason = PAID_IN_FULL`.
`ZM-PMT-015` Partial payment → `PARTIALLY_PAID` with a recalculated balance.
`ZM-PMT-016` Maturity passed with an outstanding balance and bank confirmation → `OVERDUE`, with an overdue-day counter.

### 15.6 Supplier visibility

`ZM-PMT-017` The supplier **MUST** be able to see: payment status; paid amount; outstanding amount; due date; overdue days; and recourse or dispute status.
`ZM-PMT-018` The supplier **MUST NOT** see: confidential bank reconciliation evidence; internal bank notes; the bank's own credit assessment; or any other bank's data.

### 15.7 Terminal state

`ZM-PMT-019` The single terminal state is **`CLOSED`**, with a mandatory `closureReason`:

| `closureReason` | Meaning |
|---|---|
| `PAID_IN_FULL` | Buyer paid the bank in full |
| `RECOURSE_SETTLED` | Supplier settled under recourse |
| `WRITTEN_OFF` | Bank wrote off the balance |
| `DEFAULTED` | Confirmed default, unrecovered |
| `CANCELLED_BEFORE_FUNDING` | Terminated before any funding |
| `SETTLED_BY_AGREEMENT` | Parties reached their own settlement |
| `OTHER` | Requires a free-text explanation |

`ZM-PMT-020` Financial history **MUST** remain immutable after closure. A closed transaction may be viewed and reported on, never edited.

---

## 16. Recourse, Disputes, and Bank Withdrawal

### 16.1 Recourse initiation

`ZM-REC-001` **Only an authorized bank user may initiate recourse.**
`ZM-REC-002` Platform administration **MAY**: review; facilitate; request information; record outcomes; and correct operational errors with audit evidence.
`ZM-REC-003` Administration **MUST NOT** initiate recourse on the bank's behalf.

### 16.2 Recourse reasons

| Reason code | Example |
|---|---|
| `INVALID_INVOICE` | False invoice or materially incorrect data |
| `HIDDEN_DISPUTE_OR_RETURN` | Not disclosed before funding |
| `DOUBLE_FINANCING` | Previously sold, assigned, pledged, or financed |
| `NON_DELIVERY` | Commercial transaction incomplete |
| `NON_PAYMENT` | Where payment risk sits with the supplier under the agreed recourse type |
| `OTHER` | Requires explanation |

### 16.3 Recourse workflow

`RECOURSE_INITIATED → SUPPLIER_NOTIFIED → PAYMENT_PENDING → SETTLED | DISPUTED | LEGAL_ESCALATION`

`ZM-REC-004` A recourse request **MUST** record the reason code, requested amount, and supporting evidence.
`ZM-REC-005` The supplier **MUST** be notified and **MAY** pay, provide evidence, or dispute the request under the contract.
`ZM-REC-006` The platform records the case and evidence. **It does not become a collector or an adjudicator.**

### 16.4 Recourse settlement

`ZM-REC-007` V3 **MUST** technically support supplier-to-bank recourse repayment through the same configurable settlement-provider architecture.
`ZM-REC-008` The system records: requested recourse amount; supplier repayment; provider reference; settlement status; evidence; and remaining balance.
`ZM-REC-009` Commission is **not automatically refunded** when recourse occurs.
`ZM-REC-010` Any commission refund or adjustment policy **MUST** be `CONFIGURABLE`, and any adjustment **MUST** be a compensating ledger entry.

> `LEGAL_TBD_POST_COMPETITION` — **LT-11.** Whether commission is refundable on recourse; enforceability of recourse terms; whether platform-routed recourse repayment creates any regulated activity. **Technical assumption:** no automatic refund; configurable policy; compensating entries only.

### 16.5 Commercial disputes

`ZM-REC-011` The platform opens a `Dispute` record storing reason, amount, and evidence.
`ZM-REC-012` Zimmamless **does not decide** the dispute and **does not bear** its value.
`ZM-REC-013` Automated state changes on the affected transaction **MUST** pause while a dispute is open.
`ZM-REC-014` The case is referred to the bank and supplier under their contract; the platform records the resolution the parties submit.

### 16.6 Bank withdrawal after acceptance

`ZM-REC-015` If a bank withdraws after its offer has been accepted, the platform **MUST** create a `WithdrawalCase` recording:

- withdrawal reason code;
- responsible party;
- supporting evidence;
- penalty applicability;
- configurable penalty amount;
- relisting eligibility;
- administrative decision and rationale.

#### Reason codes and default penalty treatment

| Reason code | Default penalty treatment (`CONFIGURABLE`) |
|---|---|
| `BANK_COMMERCIAL_DECISION` | Penalty may apply |
| `SUPPLIER_MISREPRESENTATION` | No bank penalty; possible fraud review of the supplier |
| `FRAUD_DISCOVERED` | Normally no penalty against the bank |
| `INVOICE_CHANGED` | Manual review |
| `CONDITION_NOT_MET` | Manual review |
| `TECHNICAL_FAILURE` | Manual review |
| `OTHER` | Manual review |

`ZM-REC-016` For the competition, the platform **records and calculates** the penalty per configurable policy.

> `LEGAL_TBD_POST_COMPETITION` — **LT-12.** Whether the withdrawal penalty is legally enforceable, and whether it is contractually invoiced or directly deducted. Also whether the supplier is entitled to compensation. **Technical assumption:** the penalty is calculated and recorded; no automatic deduction is executed; supplier compensation is not implemented.

### 16.7 Post-withdrawal relisting

`ZM-REC-017` The invoice **MUST NOT** return to the marketplace automatically. It first enters **manual review**.
`ZM-REC-018` Before relisting, the platform **MUST** confirm: no funding occurred; the invoice is still unpaid; it has not changed; it remains valid; no fraud indicator exists; and both supplier and buyer remain eligible.
`ZM-REC-019` After review it may return to `ELIGIBLE` and then be manually relisted.

### 16.8 Cancellation and amendment rules

| Stage | Rule |
|---|---|
| `DRAFT` | Supplier may edit or delete freely |
| `SUBMITTED` / `UNDER_REVIEW` | Supplier requests withdrawal; the record is preserved |
| `OPEN_FOR_OFFERS` | Cancellation permitted per policy; active offers are closed |
| `OFFER_ACCEPTED` | Cancellation subject to offer terms and bank approval |
| `CONTRACTED` / `FUNDED` | **No unilateral cancellation.** Settlement and a documented decision are required |

---

## 17. Fraud and Compliance

`ZM-FRD-001` On a fraud indicator the platform **MUST**: freeze the invoice; stop funding if it has not yet occurred; open `FRAUD_REVIEW`; and notify Compliance.
`ZM-FRD-002` The platform **MAY** request additional evidence and suspend new invoice submissions by the supplier during review.
`ZM-FRD-003` Fraud decision states: `CLEARED`, `RESTRICTED`, `SUSPENDED`, `BLACKLISTED`, `REPORTED`.
`ZM-FRD-004` A fraud case is a **suspected** case requiring investigation. It **MUST NOT** be presented as confirmed fraud until a Compliance Officer records that determination.
`ZM-FRD-005` A failed `VerificationCheck` or a high risk score **MUST NOT** automatically create a confirmed-fraud outcome.
`ZM-FRD-006` Fraud cases **MUST** support structured evidence, case assignment, and a full decision audit trail.

> `LEGAL_TBD_POST_COMPETITION` — **LT-13.** Mandatory reporting obligations, sanctions-screening requirements, AML/CFT duties, and the legal consequences of blacklisting. **Technical assumption:** the `REPORTED` state and a screening adapter exist; no specific reporting integration is implemented in V3.

---

## 18. Notifications

### 18.1 Channels

`ZM-NOT-001` V3 channels: **Email**, **WhatsApp**, **in-platform**, and **optional manual phone-call recording**.
`ZM-NOT-002` **SMS is not required** in V3. The channel abstraction **MUST** permit adding it later without core change.

### 18.2 Buyer notification

`ZM-NOT-003` Zimmamless sends the buyer notification **on behalf of the confirmed transaction**, identifying the selected bank.
`ZM-NOT-004` It is sent **after** the transaction is confirmed between bank, platform, and supplier.
`ZM-NOT-005` Content for the competition version is **operational**: confirmation that the receivable transaction is finalized; the selected bank's identity; the invoice reference; relevant payment or communication instructions; and contact details for questions.
`ZM-NOT-006` The notification **MUST NOT** request or imply any buyer approval, rejection, or decision authority.

> `LEGAL_TBD_POST_COMPETITION` — **LT-14.** Exact legal wording; whether the notification constitutes formal notice of assignment; whether acknowledgement is legally required; and required disclosures. **Technical assumption:** versioned notification templates per transaction type and language; operational wording only; full delivery evidence retained.

### 18.3 Delivery evidence

`ZM-NOT-007` For every notification the platform **MUST** store: channel; destination; send time; provider reference; delivery status; failure reason; retry count; and, where applicable, the manual call record with the recording user and outcome.
`ZM-NOT-008` Delivery evidence **MUST** be immutable and available in the audit trail.

### 18.4 Internal notifications

`ZM-NOT-009` The platform **MUST** notify at minimum: application state changes; information requests; SLA warnings; new eligible listings (banks); offer received (supplier); offer accepted/not selected (banks); contract ready for signature; funding sent; OTP pending; payout completed or failed; maturity reminders; overdue; recourse; dispute; withdrawal case; and fraud freeze.
`ZM-NOT-010` Notification templates **MUST** be versioned and bilingual.

---

## 19. Audit, Administration, and Reporting

`ZM-AUD-001` Every change to invoices, offers, contracts, payments, fees, scores, and decisions **MUST** generate an immutable `AuditLog` entry.
`ZM-AUD-002` An audit entry **MUST** record: actor user; actor organization (active context); action type; target entity type and identifier; before and after snapshots; IP address; device information; correlation identifier; and timestamp.
`ZM-AUD-003` The audit log is **append-only**. No user, including a Super Admin, may edit or delete an entry.
`ZM-AUD-004` `StatusHistory` **MUST** preserve every state transition for all significant entities. Domain logic **MUST NOT** depend solely on a current-status column where history matters.
`ZM-AUD-005` **Financial records and audit logs MUST NEVER be deleted.**

### 19.1 Uniqueness rules

`ZM-AUD-006` National establishment number **MUST** be unique per supplier and per buyer platform-wide.
`ZM-AUD-007` Active invoice fingerprint **MUST** be unique platform-wide.

### 19.2 Permission matrix

| Operation | Supplier | Bank | Administration |
|---|---|---|---|
| Edit supplier profile | Before submission, or via change request | No | Review and approve |
| Upload invoice | Yes | No | Documented support only |
| View offers | Own invoices only | Own offers only | Per permission |
| Submit offer | No | Yes | No |
| Approve offer internally | No | Yes (different user) | No |
| Accept offer | Yes | No | No |
| Sign contract | Authorized signatory | Authorized signatory | No |
| Mark funding sent / generate OTP | No | Yes | No |
| Enter funding OTP | Yes | No | No |
| Record buyer payment | Read only | Yes | Review |
| Initiate recourse | No | Yes | No |
| Open fraud review | Report only | Report only | Yes |
| Suspend account | No | No | Yes |
| Delete financial record | No | No | **No** |
| View audit log | Limited (own) | Limited (own) | Full, for authorized roles |

### 19.3 Reporting

`ZM-AUD-008` The platform **MUST** provide role-scoped reports covering: onboarding funnel and SLA performance; listing and offer activity; conversion; funding volume and value; fee and commission revenue; payment performance and ageing; overdue and recourse; dispute and fraud; and score distribution by version.
`ZM-AUD-009` Every report **MUST** respect the same confidentiality rules as the UI — no report may leak another bank's offer data or a supplier's private floor.

---

## 20. Internationalization

`ZM-I18N-001` The platform **MUST** support **English** and **Arabic** with complete translation of all user-facing text, including validation messages, emails, notifications, and generated documents.
`ZM-I18N-002` **Full RTL layout MUST** be supported for Arabic — not merely text direction, but mirrored layout, iconography, navigation, tables, and form flow.
`ZM-I18N-003` **English is the default display language** for all users, regardless of browser or device locale. The platform **MUST NOT** auto-select Arabic from locale detection.
`ZM-I18N-003a` Language switching **MUST** be available at any time, from any screen, and the chosen language **MUST** persist per user across sessions and devices.
`ZM-I18N-003b` English is the **canonical language** for contracts, notifications, and generated documents. Where an Arabic version exists, the English version governs in case of discrepancy. `LEGAL_TBD_POST_COMPETITION` — see LT-17.
`ZM-I18N-004` Dates, numbers, and currency **MUST** be localized. Currency **MUST** display as JOD with **three decimal places**.
`ZM-I18N-005` Contract and notification templates **MUST** exist in both languages, versioned independently, with a recorded canonical language per document.
`ZM-I18N-006` Bidirectional text mixing (Arabic prose containing Latin company names or IBANs) **MUST** render correctly.
---

## 21. Consolidated State Machines

### 21.1 Supplier application

```
DRAFT
  → SUBMITTED
  → AUTOMATED_VERIFICATION
  → UNDER_REVIEW
  ⇄ INFORMATION_REQUIRED ⇄ INFORMATION_RESUBMITTED
  ⇄ GOVERNMENT_SERVICE_UNAVAILABLE
  → FINAL_REVIEW
  → APPROVED | APPROVED_CONDITIONAL | REJECTED
APPROVED → ACTIVE → SUSPENDED | RESTRICTED | TERMINATED
```

### 21.2 Bank organization

```
INVITED → ONBOARDING → UNDER_REVIEW → ACTIVE → SUSPENDED → TERMINATED
```

### 21.3 Buyer resolution

```
SEARCH_INITIATED
  → CANDIDATES_PRESENTED
  → SUPPLIER_SELECTED
  → REGISTRY_LOOKUP
  → MATCHED | PARTIAL_MATCH | NOT_FOUND | MISMATCH | BLOCKED
  → BUYER_MANUAL_REVIEW (where ambiguous)
  → BUYER_RESOLVED
```

### 21.4 Invoice / ReceivableTransaction

| # | State | Notes |
|---|---|---|
| 1 | `DRAFT` | Supplier editing |
| 2 | `SUBMITTED` | Awaiting checks |
| 3 | `AUTOMATED_CHECKS` | Machine verification |
| 4 | `UNDER_REVIEW` | Human review |
| 5 | `INFORMATION_REQUIRED` | Awaiting supplier |
| 6 | `ELIGIBLE` | May be listed |
| 7 | `OPEN_FOR_OFFERS` | Listed; offer window open |
| 8 | `OFFER_ACCEPTED` | Locked; atomic |
| 9 | `CONDITIONS_PENDING` | Fulfilling offer conditions |
| 10 | `CONTRACTED` | Fully signed |
| 11 | `READY_FOR_DISBURSEMENT` | All prerequisites met |
| 12 | `FUNDING_CONFIRMATION_PENDING` | Funding sent; awaiting OTP |
| 13 | `FUNDED` | OTP + settlement evidence both confirmed |
| 14 | `PARTIALLY_PAID` | Partial buyer payment reported |
| 15 | `PAID` | Full buyer payment reported |
| 16 | `OVERDUE_UNCONFIRMED` | Past due; no bank report |
| 17 | `OVERDUE` | Past due; bank-confirmed unpaid |
| 18 | `RECOURSE_ACTIVE` | Recourse case open |
| 19 | `DISPUTED` | Dispute open; automation paused |
| 20 | `FRAUD_REVIEW` | Frozen |
| 21 | `CLOSED` | Terminal; requires `closureReason` |
| — | `REJECTED` | Terminal; pre-listing |
| — | `CANCELLED` | Terminal; pre-funding |

### 21.5 Bank offer

```
DRAFT
  → PENDING_INTERNAL_APPROVAL
  → ACTIVE
  ⇄ REVISED
  → SELECTED | NOT_SELECTED | WITHDRAWN | EXPIRED
```

### 21.6 Settlement

```
PENDING
  → FUNDING_RECEIVED
  → PAYOUT_INITIATED
  → PAYOUT_COMPLETED   (→ commission finalized)
  | PAYOUT_FAILED → RETRYING → MANUAL_REVIEW
  | REVERSED (compensating entry only)
```

### 21.7 Funding OTP

```
NOT_REQUIRED (config) | PENDING_GENERATION
  → SENT
  → VERIFIED | EXPIRED | FAILED_MAX_ATTEMPTS
  → REGENERATED (loops to SENT, up to max resends)
```

### 21.8 Recourse

```
RECOURSE_INITIATED → SUPPLIER_NOTIFIED → PAYMENT_PENDING
  → SETTLED | DISPUTED | LEGAL_ESCALATION
```

### 21.9 Withdrawal case

```
WITHDRAWAL_REQUESTED → UNDER_REVIEW
  → PENALTY_ASSESSED | NO_PENALTY
  → RELISTING_APPROVED | RELISTING_DENIED
  → CLOSED
```

---

## 22. Architecture Direction

Detailed in deliverable 5; recorded here for consistency.

| Layer | Technology |
|---|---|
| Web frontend | Next.js, React, TypeScript — responsive, bilingual, RTL |
| Backend API | Node.js with NestJS; REST with OpenAPI |
| Database | Supabase PostgreSQL |
| Authentication | Supabase Auth |
| Document storage | Supabase Storage (private buckets) |
| OCR / ML service | Python with FastAPI |
| Integrations | Adapter pattern with dummy and production implementations |

**Planned hosting:** Vercel (frontend); Render, Railway, Fly.io or equivalent (Node and Python services); Supabase (database, auth, private storage).

`ZM-ARC-001` The platform **MUST** be fully deployable and reachable, even though the competition demonstration may also run locally.
`ZM-ARC-002` No native mobile application is in scope. The product is a **responsive web application**.

### 22.1 Authorization architecture

`ZM-ARC-003` Authorization operates in **two mandatory layers**:

- **NestJS is the primary business authorization and workflow layer.** All core financial and state-changing writes go through it.
- **Supabase Row Level Security is mandatory defense in depth**, not an optional extra.

`ZM-ARC-004` The Supabase **service-role key MUST NEVER** be exposed to the frontend or to any client-side bundle.
`ZM-ARC-005` RLS policies **MUST** be tested independently of application logic; an RLS policy that only passes because NestJS filtered the query first is not an acceptable policy.

### 22.2 Adapters

`ZM-ARC-006` The following **MUST** be behind provider-neutral adapter interfaces, each with a dummy and a production implementation:

| Adapter | Purpose |
|---|---|
| `GovernmentRegistryProvider` | CCD, ISTD, GAM |
| `EInvoiceValidationProvider` | Jordanian e-invoice / QR validation |
| `SettlementProvider` | Bank-to-supplier settlement and split payout |
| `SignatureProvider` | Electronic signature and verification |
| `NotificationProvider` | Email, WhatsApp |
| `ScreeningProvider` | Sanctions and adverse-media screening |
| `RiskModelProvider` | ML inference with rules-only fallback |

`ZM-ARC-007` Replacing any dummy adapter with a production implementation **MUST NOT** require changes to core domain logic, database schema, or API contracts.

---

## 23. Non-Functional Requirements

### 23.1 Security

`ZM-NFR-001` All traffic over TLS; HSTS enabled.
`ZM-NFR-002` Passwords hashed with a modern memory-hard algorithm; MFA available and **required** for all bank and platform-admin roles.
`ZM-NFR-003` Documents in private storage; access only via short-lived signed URLs issued after a server-side authorization check.
`ZM-NFR-004` Sensitive fields (IBAN, national ID, contact numbers) encrypted at rest and masked in all UI and logs by default.
`ZM-NFR-005` OTP stored as hash only; rate-limited; attempt-capped.
`ZM-NFR-006` Idempotency keys mandatory on every settlement and webhook operation.
`ZM-NFR-007` Webhook events deduplicated by provider event identifier with a `processed` flag.
`ZM-NFR-008` All destructive or financial operations require re-authentication or step-up confirmation.
`ZM-NFR-009` Every action authorized server-side. Client-side checks are presentational only.
`ZM-NFR-010` Cross-organization data access is a **critical severity** defect class with dedicated regression tests.

### 23.2 Data integrity

`ZM-NFR-011` Money as `numeric(18,3)`; decimal arithmetic only; floating point prohibited on monetary values.
`ZM-NFR-012` Offer acceptance, settlement, and ledger writes execute in explicit database transactions with appropriate isolation.
`ZM-NFR-013` Uniqueness constraints enforced at the database level, not only in application code.
`ZM-NFR-014` Soft deletion only; no hard delete of financial, audit, or transactional records.

### 23.3 Performance and availability

`ZM-NFR-015` Interactive pages target p95 under 2 seconds under demonstration load.
`ZM-NFR-016` Government and settlement adapter calls run asynchronously with visible progress, timeouts, retries, and circuit breakers.
`ZM-NFR-017` Adapter unavailability **MUST** degrade gracefully into a paused, clearly-labelled state — never into an error the user cannot interpret or a silent failure.

### 23.4 Observability

`ZM-NFR-018` Structured logging with correlation identifiers propagated across services.
`ZM-NFR-019` Metrics on SLA compliance, adapter health, settlement success, OTP completion, and score-service availability.
`ZM-NFR-020` Alerts on ledger imbalance, payout failure, stalled funding confirmation, and RLS policy violation attempts.

### 23.5 Accessibility

`ZM-NFR-021` Target WCAG 2.1 AA: keyboard navigation, contrast, focus states, screen-reader labelling in both languages.

### 23.6 Retention

`ZM-NFR-022` Retention periods are `CONFIGURABLE` per data category.

> `LEGAL_TBD_POST_COMPETITION` — **LT-15.** Statutory retention periods for company data, transaction records, documents, and personal data; erasure rights and their interaction with financial-record immutability. **Technical assumption:** long retention by default; configurable per category; personal-data fields separable from financial records so contact data can be invalidated without touching immutable ledger entries.

> `LEGAL_TBD_POST_COMPETITION` — **LT-16.** Whether Jordan-only data residency is mandatory. **Technical assumption:** hosting region is a deployment configuration; no application logic depends on provider location.

---

## 24. Demonstration and Test Data

### 24.1 Seed data

`ZM-DEMO-001` The environment **MUST** seed at minimum: **3 banks**, **3 suppliers**, **6 buyers**, **12 invoices**, multiple bank users across every role, **1 platform admin**, **1 supplier reviewer**, **1 compliance officer**, **1 support agent**.

`ZM-DEMO-002` Seeded scenarios **MUST** include:

| Scenario | Demonstrates |
|---|---|
| Successful funding, end to end | The happy path |
| Multiple competing offers | Confidential comparison and non-highest selection |
| Information required | SLA pause and resume |
| Duplicate invoice | Fingerprint collision handling |
| Fraud review | Freeze and compliance workflow |
| Failed payout | `PAYOUT_FAILED`, retry, no duplicate payout |
| Full payment | `PAID` → `CLOSED` |
| Partial payment | `PARTIALLY_PAID` with recalculated balance |
| Overdue | `OVERDUE_UNCONFIRMED` → bank confirmation → `OVERDUE` |
| Recourse | Bank-initiated recourse through to settlement |
| Bank withdrawal after acceptance | `WithdrawalCase`, penalty assessment, manual relisting |

### 24.2 Demo time machine

`ZM-DEMO-003` A **demo-only time-control feature MUST** exist, able to: advance invoice maturity; trigger reminder notifications; simulate overdue status; demonstrate partial payment; and demonstrate recourse.
`ZM-DEMO-004` It **MUST** be disabled and inaccessible in production environments, gated by environment configuration **and** a server-side guard — not by hiding the UI.
`ZM-DEMO-005` Every time-machine action **MUST** be audited and clearly flagged in the record as simulated.

---

## Appendix A — Legal TBD Register

| ID | Description | Module | Current technical assumption | Specialist required | Decision needed by |
|---|---|---|---|---|---|
| **LT-01** | Whether buyer notification is formal assignment notice; whether acknowledgement is required; legal basis for processing supplier-provided buyer contact data | `BUY`, `NOT` | Operational notification; full delivery evidence; contact data correctable and invalidatable; role-restricted | Commercial + data protection counsel | Before production launch |
| **LT-02** | Treatment of companies under liquidation or insolvency (supplier and buyer) | `SON`, `BUY` | Configurable policy; default manual review escalating to rejection | Insolvency counsel + credit policy | Before production launch |
| **LT-03** | Permissible storage, sharing, reuse, and retention of government-sourced data; consent scope for onward disclosure to banks | `GOV` | Versioned per-purpose consent; snapshots retained; bank disclosure policy-gated | Data protection counsel + registry liaison | Before real API integration |
| **LT-04** | Enforceability and precise wording of supplier declarations and indemnity | `INV`, `CON` | Versioned declaration template; accepted version stored per submission | Commercial counsel | Before production launch |
| **LT-05** | Lawful basis and consent scope for disclosing supplier, signatory, and buyer personal data to banks | `MKT` | Versioned consent; field-level disclosure policy per recipient role | Data protection counsel | Before production launch |
| **LT-06** | Legal effect and enforceability of each `transactionType` and each `recourseType` | `OFR`, `CON` | Enums driving template and disclosure selection; no legal consequence inferred by the system | Commercial + banking counsel | Before production launch |
| **LT-07** | Legal mechanism for collecting, invoicing, and enforcing the listing fee, especially where no funding occurs | `FEE` | Recorded as a ledger receivable; collection adapter-driven and configurable | Commercial counsel | Before charging real fees |
| **LT-08** | Contract wording; enforceability of click-to-accept signature; whether Zimmamless must be a contract party to charge its fee | `CON` | Two-party contract; separate versioned platform terms; `AssignmentRecord` placeholder retained | Commercial counsel + e-signature specialist | Before production launch |
| **LT-09** | Whether legal perfection or registration of assignment is required in Jordan, and who is responsible | `CON` | Bank responsibility; platform records evidence only | Secured-transactions counsel | Before production launch |
| **LT-10** | Whether routing funds through the platform requires a CBJ payment-service licence; controlled account vs. licensed split settlement | `FND`, `FEE` | Abstract settlement adapter with explicit split-settlement support | Financial-regulatory counsel | **Before any real money movement** |
| **LT-11** | Commission refundability on recourse; enforceability of recourse terms; regulatory status of platform-routed recourse repayment | `REC`, `FEE` | No automatic refund; configurable policy; compensating entries only | Commercial + regulatory counsel | Before production launch |
| **LT-12** | Enforceability of the bank withdrawal penalty; invoiced vs. deducted; supplier compensation entitlement | `REC` | Calculated and recorded; no automatic deduction; no compensation implemented | Commercial counsel | Before production launch |
| **LT-13** | Mandatory reporting, sanctions screening, AML/CFT duties; legal consequences of blacklisting | `FRD` | `REPORTED` state and screening adapter exist; no reporting integration in V3 | AML/compliance specialist | **Before production launch** |
| **LT-14** | Exact legal wording of buyer notification; formal-notice status; required acknowledgement and disclosures | `NOT` | Versioned bilingual templates; operational wording; delivery evidence retained | Commercial counsel | Before production launch |
| **LT-15** | Statutory retention periods; erasure rights vs. financial-record immutability | `AUD` | Long default retention; configurable per category; personal data separable from immutable ledger | Data protection counsel | Before production launch |
| **LT-16** | Whether Jordan-only data residency is mandatory | `ARC` | Hosting region is deployment configuration; no logic depends on provider location | Data protection + regulatory counsel | Before production launch |
| **LT-17** | Whether English may serve as the governing language of contracts executed in Jordan, or whether an Arabic version must govern for enforceability or filing | `I18N`, `CON` | English canonical and governing; Arabic provided as an accurate translation; both versions stored and versioned independently per contract | Commercial counsel + Jordanian litigation counsel | Before production launch |

**Highest urgency:** LT-10 (payment licensing) and LT-13 (AML) are the two items that could materially alter the operating model rather than merely the paperwork. They should be raised first.

---

## Appendix B — Open Assumptions Requiring Owner Confirmation

These were not covered by the answered questions and were filled by the authoring team. Each is safe to override.

| ID | Assumption | Where |
|---|---|---|
| **AS-01** | Offer acceptance requires the Supplier Owner/Admin role by default; configurable to allow Invoice Uploader | §3.3.2 |
| **AS-02** | Selection-deadline reminders fire at 50% and 15% of remaining time | §10.2 |
| **AS-03** | Settlement retry policy: 3 automatic attempts with exponential backoff before manual review | §14.6 |
| **AS-04** | Escalation of stalled funding confirmation goes to Operations Admin, not Super Admin | §14.4 |
| **AS-05** | Trust Score band thresholds: `LOW` ≥ 75, `MEDIUM` 50–74, `HIGH` 25–49, `CRITICAL` < 25 | §9.2 |
| **AS-06** | Listing fee is a flat configurable amount rather than a percentage in V3 | §12.3 |
| **AS-07** | Invoices with a due date already in the past are ineligible for listing | §8 |
| **AS-08** | Minimum tenor for listing eligibility is 7 days to maturity | §10 |
| **AS-09** | A supplier may hold multiple concurrent active listings, subject to a configurable exposure cap | §10 |

> **Confirmed and removed from this register:** the former **AS-10** (default display language) was confirmed by the product owner on 22 July 2026 as **English default, Arabic via switcher**, and is now a binding requirement at `ZM-I18N-003`. All other assumptions above were confirmed as written on the same date.

---

## Appendix C — Glossary

| Term | Definition |
|---|---|
| **CCD** | Companies Control Department — Jordan's companies registry |
| **ISTD** | Income and Sales Tax Department |
| **GAM** | Greater Amman Municipality (or equivalent licensing authority) |
| **Buyer / debtor** | The company that owes the invoice; never a platform user |
| **Face value** | Original total invoice amount |
| **Outstanding amount** | `faceValue − paidAmount`; the amount available to fund |
| **Gross funding amount** | Total the bank commits against the receivable |
| **Net supplier payout** | What the supplier actually receives after all deductions |
| **Minimum acceptable amount** | The supplier's private minimum **net** payout floor |
| **Listing fee** | Charged at listing activation, regardless of outcome |
| **Platform commission** | Success fee, finalized only on completed payout |
| **Trust Score** | Composite 0–100 decision-support indicator with five components |
| **Fingerprint** | Deterministic hash over invoice identity fields used for duplicate detection |
| **Snapshot** | Immutable frozen copy of data at a decision point |
| **Compensating entry** | A reversal ledger entry; never a deletion or edit |
| **Adapter** | Provider-neutral interface with dummy and production implementations |
| **`LEGAL_TBD_POST_COMPETITION`** | A legal question deferred to post-competition specialist review |

---

## Appendix D — Requirements Traceability Summary

| Module | Requirement range | Count |
|---|---|---|
| `IAM` / `ROL` | `ZM-IAM-001`–`002`, `ZM-ROL-001`–`008` | 10 |
| `SON` | `ZM-SON-001`–`013` | 13 |
| `GOV` | `ZM-GOV-001`–`009` | 9 |
| `BUY` | `ZM-BUY-001`–`015` | 15 |
| `INV` | `ZM-INV-001`–`005` | 5 |
| `DOC` | `ZM-DOC-001`–`010` | 10 |
| `VER` | `ZM-VER-001`–`002` | 2 |
| `RSK` | `ZM-RSK-001`–`018` | 18 |
| `MKT` | `ZM-MKT-001`–`017` | 17 |
| `OFR` | `ZM-OFR-001`–`019` | 19 |
| `SEL` | `ZM-SEL-001`–`008` | 8 |
| `FEE` | `ZM-FEE-001`–`019` | 19 |
| `CON` | `ZM-CON-001`–`018` | 18 |
| `FND` | `ZM-FND-001`–`019` | 19 |
| `PMT` | `ZM-PMT-001`–`020` | 20 |
| `REC` | `ZM-REC-001`–`019` | 19 |
| `FRD` | `ZM-FRD-001`–`006` | 6 |
| `NOT` | `ZM-NOT-001`–`010` | 10 |
| `AUD` | `ZM-AUD-001`–`009` | 9 |
| `I18N` | `ZM-I18N-001`–`006` (incl. `003a`, `003b`) | 8 |
| `ARC` | `ZM-ARC-001`–`007` | 7 |
| `NFR` | `ZM-NFR-001`–`022` | 22 |
| `DEMO` | `ZM-DEMO-001`–`005` | 5 |
| **Total** | | **288** |

---

## Approval

This document is deliverable **1 of 6**. On approval, the next deliverables follow in order:

2. Updated Domain / Class Model
3. Updated ERD
4. Updated Workflow and State Diagrams
5. System Architecture
6. Detailed Implementation Plan

**No application code will be written until deliverable 6 is approved.**

*End of Zimmamless V3 Consolidated System Requirements.*
