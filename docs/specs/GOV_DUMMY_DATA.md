# Government Dummy Data & Seed Identities

**Owner:** Agent A · **Status:** draft (Phase 0 deliverable; identities frozen at Phase 2)
**Consumers:** Agent A's dummy adapters and seed · Agent B's MSW mock fixtures

The point of this file is that both agents test against the *same* people and
companies. When Agent B swaps an endpoint from mock to live, the screen
should show the same names and numbers it showed a minute earlier — any
difference is then a real bug rather than a fixture mismatch (Master Plan
3.4 §3).

**Identities below are frozen once Phase 2 starts.** Adding is fine;
renaming or renumbering breaks the other agent's fixtures silently.

---

## 1. National establishment numbers

Jordanian national establishment numbers are 8 digits. The ranges are chosen
so a number's role is obvious on sight while debugging:

| Range | Meaning |
|---|---|
| `2000xxxx` | Suppliers |
| `3000xxxx` | Buyers |
| `4000xxxx` | Banks |
| `9000xxxx` | Failure-injection keys (see §5) |

## 2. Suppliers

| # | Establishment no. | Legal name (EN) | Legal name (AR) | Governorate | Sector | Phase 1 seed | Registry behaviour |
|---|---|---|---|---|---|---|---|
| S1 | `20000101` | Al-Noor Trading Company | شركة النور للتجارة | Amman | Wholesale | yes | CCD/ISTD/GAM all full |
| S2 | `20000102` | Petra Industrial Supplies | بتراء للتوريدات الصناعية | Zarqa | Manufacturing | yes | CCD full, GAM partial |
| S3 | `20000103` | Jordan Valley Foods | أغذية وادي الأردن | Irbid | Food | no (Phase 2) | ISTD unavailable — drives the SLA-pause scenario |
| S4 | `20000104` | Hani Auto Parts Establishment | مؤسسة هاني لقطع غيار السيارات | Amman | Retail | no — register it | **Sole proprietorship** — hard-rejected (ZM-SON-012/013) |
| S5 | `20000105` | Amman Steel Works | أعمال عمان للحديد | Amman | Manufacturing | no — register it | All sources full; reserved for the register → approve flow |

S1 is the demo's protagonist (Master Plan 6.2).

**S4 and S5 were added in Phase 2** (announced in the daily log, 2026-07-23).
Nothing was renamed or renumbered. Both exist because a required path had no
identity to run on:

- **S4** is the only sole proprietorship, so ZM-SON-013's ineligibility
  screen and its hard-rejection test had no fixture without it.
- **S5** is deliberately **not** seeded as an organization. Every other
  full-success supplier already is, so `POST /onboarding/register` returns
  409 for all of them and the Phase 2 integration checkpoint — register →
  submit → approve — could not be run end to end. S5 is the identity to
  register with when demonstrating that flow. Registering it consumes it:
  a second registration returns 409, which is correct behaviour.

## 3. Buyers

Buyers are never platform users. They are registry records plus a debtor
row, notified after the fact (`00_START_HERE.md` §1).

| # | Establishment no. | Legal name (EN) | Registry status | Purpose |
|---|---|---|---|---|
| B1 | `30000201` | Amman Retail Group | `ACTIVE` | Happy path |
| B2 | `30000202` | Levant Construction Co. | `ACTIVE` | Second buyer for S1 |
| B3 | `30000203` | Aqaba Logistics Ltd | `ACTIVE` | Partial-payment scenario |
| B4 | `30000204` | Northern Textiles | `SUSPENDED` | Blocked-buyer 409 (ZM-BUY) |
| B5 | `30000205` | Desert Rose Trading | `STRUCK_OFF` | Blocked-buyer 409, second variant |
| B6 | `30000206` | Capital Medical Supplies | `UNDER_LIQUIDATION` | Blocked, third variant |

Agent B needs B4–B6 to build the block-state screens; they exist from the
Phase 1 seed onward so those screens are never blocked on Phase 3.

## 4. Banks

Bank onboarding is seed-only in V3 (PA-01): banks are created `ACTIVE` with
real user accounts and no onboarding endpoints exist.

| # | Establishment no. | Legal name (EN) | Licence | SWIFT |
|---|---|---|---|---|
| K1 | `40000301` | Jordan National Bank | `CBJ-2019-011` | `JNBAJOAX` |
| K2 | `40000302` | Levant Commercial Bank | `CBJ-2017-004` | `LCBKJOAX` |
| K3 | `40000303` | Capital Investment Bank | `CBJ-2020-022` | `CIBKJOAX` |

**Two banks are the minimum the RLS suite needs**, not a nicety: INV-11 is
the assertion that K1 cannot see K2's rows, which is unprovable with one
bank seeded. All three exist from Phase 1.

## 5. Failure-injection keys

Deterministic, so "the registry is down" is a reproducible test rather than
a timing accident. Looking up these numbers makes the dummy adapter behave
as described regardless of source:

| Key | Adapter behaviour | Exercises |
|---|---|---|
| `90000001` | `UNAVAILABLE`, `source_available = false` | INV-9, `GOVERNMENT_SERVICE_UNAVAILABLE`, SLA pause |
| `90000002` | `NOT_FOUND`, `source_available = true` | Adverse-but-answered — must be treated differently from the row above |
| `90000003` | `PARTIAL` — half the fields present | `dataAvailabilityPct` below 100 with components unchanged |
| `90000004` | `ERROR` (HTTP 500 from the source) | Retry and error surfacing |
| `90000005` | Success after a 6-second delay | Timeout handling |

The distinction between `90000001` and `90000002` is the fourth defining
behaviour of the product, and INV-9's paired-fixture test is built directly
on this pair: identical facts, one with sources down, asserting the five
component scores are **identical** and only `dataAvailabilityPct` differs.

## 6. Users and passwords

Convention: `<role>@<org-slug>.zimmamless.test`, all with the same
development password. These are test accounts on a demo project and are
never used anywhere real.

**Password (all seeded users): `Zimmamless#2026`**

| Email | Name | Org | Roles |
|---|---|---|---|
| `owner@alnoor.zimmamless.test` | Rania Haddad | S1 | `SUPPLIER_OWNER`, `SUPPLIER_SIGNATORY` |
| `uploader@alnoor.zimmamless.test` | Omar Khalil | S1 | `SUPPLIER_UPLOADER` |
| `owner@petra.zimmamless.test` | Yousef Nasser | S2 | `SUPPLIER_OWNER`, `SUPPLIER_SIGNATORY` |
| `admin@jnb.zimmamless.test` | Layla Mansour | K1 | `BANK_ADMIN` |
| `maker@jnb.zimmamless.test` | Tariq Odeh | K1 | `BANK_OFFER_MAKER`, `BANK_ANALYST` |
| `approver@jnb.zimmamless.test` | Nadia Rifai | K1 | `BANK_OFFER_APPROVER` |
| `ops@jnb.zimmamless.test` | Sami Barakat | K1 | `BANK_OPERATIONS` |
| `maker@lcb.zimmamless.test` | Huda Salameh | K2 | `BANK_OFFER_MAKER` |
| `approver@lcb.zimmamless.test` | Faris Zoubi | K2 | `BANK_OFFER_APPROVER` |
| `ops@lcb.zimmamless.test` | Dina Aql | K2 | `BANK_OPERATIONS` |
| `maker@cib.zimmamless.test` | Bashar Tell | K3 | `BANK_OFFER_MAKER` |
| `admin@platform.zimmamless.test` | Zaid Qasem | P1 | `PLATFORM_SUPER_ADMIN`, `PLATFORM_OPS_ADMIN` |
| `reviewer@platform.zimmamless.test` | Maha Darwish | P1 | `PLATFORM_SUPPLIER_REVIEWER` |
| `compliance@platform.zimmamless.test` | Khalid Amir | P1 | `PLATFORM_COMPLIANCE` |

Maker and approver are **different people at every bank** because ZM-ROL-002
separation is enforced by a DB CHECK (`chk_maker_approver_differ`) as well as
in the service. A seed with one bank user could not demonstrate INV-12.

`multi@platform.zimmamless.test` (Sara Yaseen) holds memberships in **both
S2 and P1** — the multi-org context switcher is otherwise untestable, and
switching context is a Phase 1 checkpoint item.

## 7. Platform organization

| Establishment no. | Legal name |
|---|---|
| `40000001` | Zimmamless Platform |

## 6a. Adapter payload shapes (drafted Phase 2)

Each source supplies a fixed set of normalized field keys. The set is the
**denominator of `dataAvailabilityPct`** — a `PARTIAL` answer supplies some
of them, an unavailable source supplies none, and without a declared
expected set the two are indistinguishable from a complete answer that
happens to be short.

| Source | Normalized field keys |
|---|---|
| **CCD** | `legalNameEn`, `legalNameAr`, `companyType`, `registryStatus`, `commercialRegistrationNo`, `registrationDate`, `paidCapitalJod`, `governorate` |
| **ISTD** | `taxNumber`, `taxStatus`, `vatRegistered`, `lastFilingPeriod` |
| **GAM** | `professionLicenceNumber`, `licenceStatus`, `licenceExpiryDate`, `premisesAddress`, `activityCode` |

Value domains: `companyType` ∈ `LIMITED_LIABILITY | PRIVATE_SHAREHOLDING |
PUBLIC_SHAREHOLDING | GENERAL_PARTNERSHIP | SOLE_PROPRIETORSHIP` ·
`registryStatus` ∈ `ACTIVE | SUSPENDED | STRUCK_OFF | UNDER_LIQUIDATION |
UNKNOWN` · `taxStatus` ∈ `REGISTERED | NOT_REGISTERED | DEREGISTERED` ·
`licenceStatus` ∈ `VALID | EXPIRED | SUSPENDED`.

`paidCapitalJod` is a **3-dp string** (`"50000.000"`), never a number —
money is a string on every wire in this system, including this one.

Every normalized value is a string. `vatRegistered` is `"true"`/`"false"`,
not a boolean: these are provenance-carrying field values stored in one
`entity_field_values.field_value` text column, and a per-field type would
have to be reconstructed on read anyway.

`PARTIAL` drops the second half of the field list, by position — not at
random, so the same key always yields the same partial answer and
`dataAvailabilityPct` is assertable.

The **raw** payload is shaped differently on purpose (`source_system`,
`queried_establishment_no`, `record`) so that `raw_payload` and
`normalized_payload` in `government_data_snapshots` are visibly not the
same object. `payload_hash` is sha256 over the canonicalized **raw**
payload, so re-fetching the same answer hashes identically while a change
to our own mapping does not disturb it.

## 8. Open items

- ~~CCD/ISTD/GAM exact payload shapes~~ — **closed**, §6a above (Phase 2).
- Which of the 12 invoices sits in which of the 11 scenarios — Seed-Data
  Specification, Phase 9.
- The seeded public-holiday calendar (`db/seed/0200_seed_phase2.sql`) uses
  **approximate** dates for the lunar Islamic holidays. Fixed-date holidays
  are correct. The product owner should replace them with the official
  Jordanian calendar before any non-demo use.
