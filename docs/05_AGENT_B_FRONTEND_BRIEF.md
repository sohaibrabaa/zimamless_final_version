# Agent B — Frontend Brief

**Session:** B (web application)
**Owns:** Next.js app, all UI, i18n, client state, design system
**Does NOT own:** anything under `/apps/api`, `/services/ml`, `/db`

---

## 1. Read first, in this order

1. `01_ZIMMAMLESS_V3_REQUIREMENTS.md` — full product definition
2. `03_API_CONTRACT.yaml` — **frozen**; this is your entire backend surface
3. This brief

You do not need to read the SQL schema. If you find yourself needing it, that means the API contract is missing something — raise it rather than reaching around.

## 2. Frozen contract

`03_API_CONTRACT.yaml` may not be changed by you. Generate a typed client from it and build against that. If an endpoint is missing or a shape is wrong, **stop and raise it** — do not invent a workaround or call an endpoint that isn't in the spec.

Work against generated mocks from day one. Do not wait for Agent A.

## 3. Repository layout

```
/apps/web
  /app
    /[locale]                       en | ar
      /(auth)/login, /register
      /(supplier)
        dashboard/
        onboarding/                 wizard + SLA tracker
        invoices/                   list, new (wizard), [id]
        offers/[listingId]/         comparison view
        contracts/[id]/
        funding/[id]/               OTP entry
        payments/
      /(bank)
        dashboard/
        marketplace/                eligible listings
        listings/[id]/              underwriting view
        offers/                     my offers, create, approve queue
        funding/                    mark sent, OTP generation
        payments/                   report buyer payments
        recourse/
        settings/policy-filters/
      /(platform)
        dashboard/
        applications/               review queue
        transactions/
        cases/                      fraud, disputes, withdrawal
        settings/                   fees, tiers, risk models
        audit/
  /components
    /ui                             design system primitives
    /money                          MoneyDisplay, MoneyInput
    /offers                         OfferCard, OfferBreakdown, OfferComparison
    /risk                           TrustScoreGauge, ComponentBars, FactorList
    /forms
  /lib
    api/                            generated client from OpenAPI
    i18n/                           en.json, ar.json
    money.ts                        decimal handling
  /messages
    en.json
    ar.json
```

## 4. Build order

**Phase 1 — Shell**
- Next.js app router, `[locale]` segment, EN + AR, RTL layout
- Design system: colors, type, spacing, buttons, inputs, tables, modals
- Auth flow against Supabase; org context switcher in the header
- Generated API client + MSW mocks from the OpenAPI spec
- Role-gated navigation shells for all three portals

**Phase 2 — Supplier onboarding**
- Registration, email/phone verification
- Onboarding wizard: establishment number → licence → consents → bank account
- **Government-derived fields render read-only with a source badge and retrieval date** — never as editable inputs
- SLA tracker: remaining business time, paused state with reason
- Information-request inbox and response form

**Phase 3 — Invoice submission wizard**
- Step 1 Buyer: search → candidate list → explicit selection → contact form
  - Never pre-select a candidate, even at 100% name match
  - Show registry status; block on SUSPENDED/STRUCK_OFF with a clear reason
- Step 2 Invoice: upload e-invoice → OCR pre-fill → supplier reviews
  - Show extracted vs. entered values; highlight mismatches; user can correct
  - Make clear that corrections are recorded alongside, not replacing, the extraction
- Step 3 Documents
- Step 4 Minimum acceptable amount
  - Label explicitly as the **minimum NET amount you will receive**
  - Show a privacy note: banks never see this
- Step 5 Declarations — all must be checked
- Step 6 Review and submit

**Phase 4 — Marketplace, supplier side**
- Listing activation screen showing the **listing fee before confirmation**, with the warning that it applies whether or not financing succeeds
- Offer comparison — the most important screen in the product:
  - Full breakdown per offer: gross, each deduction, net
  - Net payout as the visual anchor
  - Transaction type and recourse type prominently displayed with plain-language explanation
  - Conditions listed, mandatory ones flagged
  - **Never sort by amount alone or mark any offer "best"** — the product position is that the highest offer is not necessarily the right one
  - Countdown to selection deadline
- Acceptance confirmation modal spelling out that this is atomic and irreversible

**Phase 5 — Bank portal**
- Eligible listings feed
- Underwriting view: supplier, buyer, invoice, documents, Trust Score
  - Trust Score: composite gauge + five component bars + factors + reason codes + version + date
  - Data availability shown **separately** from the score, with an explanatory tooltip
  - Disclaimer visible: decision support, not a guarantee
- Offer creation: enter gross + bank deductions; commission and listing fee shown as server-computed read-only; net previewed live
- Approval queue — approver sees who created each offer; self-approval blocked in UI as well as server-side
- Policy filter configuration

**Phase 6 — Contracts and funding**
- Contract review and click-to-accept signature; signature status per party
- Bank: mark funding sent; generate OTP — **display once, with a clear "copy this now" affordance**
- Supplier: OTP entry with attempts remaining; generic failure messaging only
- Settlement status; payout tracking

**Phase 7 — Post-funding and cases**
- Payment timeline; outstanding balance; overdue days
- `OVERDUE_UNCONFIRMED` must read as *"awaiting bank confirmation"*, never as *"defaulted"*
- Bank: report payment, confirm status, initiate recourse
- Supplier: recourse response
- Dispute and fraud views

**Phase 8 — Platform admin**
- Application review queue with decision actions
- Settings, commission tiers, risk model versions
- Audit log search
- Case management

**Phase 9 — Polish**
- Full Arabic pass with RTL verification on every screen
- Accessibility: WCAG 2.1 AA, keyboard nav, focus, contrast, screen-reader labels in both languages
- Empty, loading, and error states everywhere
- Demo time-machine control (hidden unless the API reports it enabled)

## 5. Rules you must not break

**Money.** Never use JavaScript numbers. API sends `"1250.000"` strings. Parse with a decimal library, display with three decimals and a JOD label. Never `parseFloat`.

**The supplier's floor.** `minimumAcceptableAmount` may appear only in supplier and platform views. If it ever renders in a bank-facing component, that is a critical defect.

**Competitor data.** Bank screens must never show another bank's identity, amount, conditions, or the number of competing offers. If the API returns something it shouldn't, raise it — do not just hide it in CSS.

**Language.** English is the default for every user regardless of browser locale. **Do not implement locale auto-detection.** Arabic only via explicit switch, then persisted.

**Government fields.** Always read-only, always with a source badge and retrieval timestamp. Never an editable input.

**Score vs. availability.** A missing government field is not bad news. UI must present unavailability neutrally — never in a warning color or with a downward arrow.

**Selection framing.** No "recommended", "best value", or default sort by amount. The supplier decides on the whole package.

## 6. RTL specifics

Not just `dir="rtl"`. Mirror layout, navigation, icon direction, table column order, progress indicators, and form flow. Numbers and IBANs stay LTR inside Arabic text — test bidirectional rendering explicitly. Test every screen in Arabic, not a sample.

## 7. Interface with Agent A

- Generate your client from `03_API_CONTRACT.yaml`, not from Agent A's running server
- Use MSW mocks until an endpoint is confirmed live
- Any contract gap goes to the product owner, not into a workaround
- Post a daily note listing screens completed and any contract issues found
