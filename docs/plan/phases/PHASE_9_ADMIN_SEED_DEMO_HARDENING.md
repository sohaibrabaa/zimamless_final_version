# Phase 9 — Admin, Seed, Demo, Hardening (A + B converge)

**Objective:** everything the demo needs, and nothing untested that the demo touches. This is the convergence phase: both agents finish their halves, then jointly rehearse.

## Agent A tasks

- [ ] Admin: `/admin/settings` GET/PATCH (audited); `/admin/commission-tiers` GET/POST; `/admin/risk-models` finalized; `/admin/audit-logs` search; `/admin/relisting-requests` finalized.
- [ ] **Full seed per `docs/specs/SEED_DATA.md`:** 3 banks, 3 suppliers, 6 buyers, 12 invoices, users for every role (ZM-DEMO-001); all **11 scenarios** positioned (successful funding, competing offers, information required, duplicate, fraud review, failed payout, full payment, partial payment, overdue, recourse, bank withdrawal); **twin copies** of every live-demo entity one state earlier (fallback per Demo Plan); contract + notification templates seeded; commission tiers seeded.
- [ ] Demo time machine: `POST /demo/time-travel` — **server-side env guard** (`demo_time_machine_enabled=false` → 404, verified against production config); every use audited + records flagged simulated (ZM-DEMO-003..005); jobs re-evaluate on offset change; `demo` block in `/auth/me` (D-10).
- [ ] `reset-demo` script: pristine seed restore in < 1 min (clears `demo_time_offsets`).
- [ ] Complete invariant suite: INV-1..13 all named, all green in CI; nightly deep suite (RLS personas, sentinel scan, concurrency, ledger balance) green.
- [ ] Performance: p95 < 2 s on demo data (ZM-NFR-015); adapter latency async with visible progress (ZM-NFR-016/017).
- [ ] `docs/ops/DEPLOY_RUNBOOK.md` finalized and executed: hosted stack fully deployed; scripted local fallback stack (`docker compose` + Supabase CLI) mirroring the seed.

### Endpoints in scope (A)

`/admin/settings` · `/admin/commission-tiers` · `/admin/audit-logs` · `/admin/relisting-requests` + approve · `/demo/time-travel`

## Agent B tasks

- [ ] Platform admin screens: settings (read + guarded edit), commission tiers, risk model versions (create/activate with rationale), audit-log search with entity filter.
- [ ] Demo time-machine control: visible **only** when `/auth/me` reports it enabled (D-10); offset display; "simulated" flag surfaced on affected records.
- [ ] **Full Arabic + RTL pass on every screen** per `docs/specs/RTL_CHECKLIST.md` — every screen, not a sample (brief §6): mirrored layout/nav/icons/tables/progress/forms; bidi checks (IBANs, establishment numbers, Latin names LTR inside Arabic text); localized dates/numbers; JOD 3 dp in both locales.
- [ ] Accessibility pass: WCAG 2.1 AA — keyboard nav, focus states, contrast, screen-reader labels in both languages (ZM-NFR-021); axe-core per screen + manual keyboard run on the demo path in both directions.
- [ ] Empty, loading, and error states verified on every screen; correlation-id surfaced on error screens for support.
- [ ] Playwright demo-path E2E green in `en` and `ar`; visual snapshots for offer comparison, invoice wizard, funding OTP.
- [ ] `ENDPOINT_STATUS.md`: zero `mock` entries on any demo-path endpoint.

### Screens in scope (B)

Admin settings · tiers · risk models · audit search · time-machine control · (verification passes across all existing screens).

## Joint tasks

- [ ] Execute `docs/demo/DEMO_SCRIPT.md` (from Master Plan Part 6) end to end on the **deployed** stack — twice: once in English, once in Arabic — the second run driven by someone who didn't build the flow.
- [ ] Fallback rehearsal: twin-scenario switch, environment switch to local stack, reset script.
- [ ] Record the rehearsal (chaptered video = last-resort demo fallback).
- [ ] Production-config drill: with `demo_time_machine_enabled=false`, `/demo/time-travel` returns 404 and the UI control is absent.

## Ownership & collision guard

Disjoint trees throughout; the only joint artifact is the rehearsal + `DEMO_SCRIPT.md` annotations (append-only notes).

## Dependencies

Phases 1–8 checkpoints all passed.

## Integration checkpoint

The full demo script runs twice (EN + AR) on the deployed stack without improvisation; reset restores seed in < 1 min; all CI suites green including nightly deep suite; every data-only scenario reachable in ≤ 3 clicks from its portal dashboard.

## Definition of done

Demo rehearsal sign-off recorded by the product owner in `DECISIONS.md`; competition submission pack inputs delivered (screenshots, architecture note, honest ML-limitations statement).

## Effort

Agent A: 5–7 days · Agent B: 5–7 days (overlapping; rehearsals joint).

## Completion reports

`docs/completion/PHASE_9_AGENT_A.md` · `PHASE_9_AGENT_B.md` · `PHASE_9_CHECKPOINT.md` — plus the final `docs/completion/PROJECT_CLOSEOUT.md` (joint): what shipped vs. plan, known gaps, and the post-competition backlog (incl. the LT-01..17 legal handover).
