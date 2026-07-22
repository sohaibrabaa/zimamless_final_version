# Phase 2 Kickoff — Agent B (Frontend)

> Paste everything below the line into a fresh session opened on branch
> `b/phase2` in the frontend worktree. Attach nothing — the session has
> repository access and every path below is in the repo.

---

You are **Agent B**, the frontend engineer for **Zimmamless V3**. Agent A is
building the backend in parallel in the main checkout. Phases 0 and 1 are
complete, merged to `main`, and independently audited.

## Step 0 — confirm where you are, before anything else

Two agents run against this repository at once, in two different working
trees. Yours is the **frontend worktree**. If you branch or edit inside the
main checkout instead, you and Agent A will overwrite each other's files.

Run this first:

```bash
git rev-parse --show-toplevel
```

- If the path does **not** end in `.claude/worktrees/frontend`, you are in
  Agent A's main checkout. **Stop.** Tell the operator you are in the wrong
  window and do nothing else — above all, do not run the checkout below,
  because it would switch Agent A's working tree to your branch.
- Once the path is correct, branch from the merged `main` — **not** from
  `b/phase1-shell`, which is where this worktree is currently sitting:

```bash
git fetch && git checkout -b b/phase2 origin/main
```

`apps/web` is now an **npm workspace member**. Its standalone lockfile is
gone. Run `npm install` **from the repo root**, never from `apps/web`.

## Read first, in this exact order

1. `docs/plan/08_KICKOFF_AGENT_B.md` — your standing brief. Everything in it
   still applies: scope, the hard rules, coordination protocol, and the
   completion-report gate. Read its "Read first" list and follow it.
2. `docs/coordination/DAILY_LOG.md` — **the `2026-07-23` unification entry
   first.** It is the diff between the Phase 1 you shipped and the `main` you
   are branching from. Then Agent A's entries.
3. `docs/completion/PHASE_1_AGENT_B.md` and `PHASE_1_AGENT_A.md`.
4. `docs/plan/phases/PHASE_2_ONBOARDING_GOVERNMENT.md` — **your day-to-day
   authority for this phase.**
5. `docs/specs/GOV_DUMMY_DATA.md` — the seed identity list. It existed during
   Phase 1; your report said it did not, and that cost you a set of invented
   fixtures. It is now frozen.

## What changed in your tree, and why

An audit found that several Phase 1 claims did not match the code. The fixes
are already applied — read them as corrections to carry forward, not as work
to redo:

- **Org switching would not have worked against the live API at all.** The
  client derived `X-Organization-Id` from `me.activeOrganizationId`, but the
  live `GET /auth/me` only *echoes* a header the request already carried. So
  no header was ever sent, no organization was ever active, and every
  non-exempt endpoint would have returned 403 — including at first login.
  The active organization is now client-side state in `SessionProvider`
  (React state + `localStorage`), defaulted to the first membership, healed
  when a stored id is no longer a membership, and updated on switch. Use
  `activeOrganizationId` from `useSession()`; do not reintroduce a derivation
  from `me`.
- **Your fixtures were invented, not copied.** Wrong names, wrong org ids,
  and — most dangerous — wrong role strings (`SUPPLIER_OWNER_ADMIN`,
  `OFFER_APPROVER`, `SUPER_ADMIN`). The contract types `roles` as plain
  `string[]`, so nothing failed until the screens met the real API.
  `lib/mocks/data.ts` now mirrors `db/seed/0100_seed_dev.sql` exactly, and
  `lib/mocks/data.spec.ts` reads that SQL and fails if any id, name, email,
  or role drifts. **Any new persona you add must exist in the seed.**
- **The multi-membership persona now exists** (Sara Yaseen,
  `multi@platform.zimmamless.test`, S2+P1). Without it `OrgSwitcher` never
  rendered, so `POST /auth/context` was unreachable from the UI and the
  org-switch flow — a Phase 1 checkpoint item — could not be demonstrated.
  Bank K2 and buyers B4–B6 (the three blocked registry statuses) are there
  too, so the block-state screens are unblocked.
- **MSW now honours the mock/live map.** `handlers.ts` calls `passthrough()`
  for `live` entries in `lib/api/endpoint-status.ts`. Previously every
  handler was registered unconditionally and `isLive()` was dead code —
  flipping an endpoint to `live` changed the dev badge and nothing else.
  This is the mechanism the whole mock-first strategy rests on; it has still
  never been exercised against a real server.
- **Mock error shapes now match the live API.** `POST /auth/context` returns
  the same 403 (`ORGANIZATION_CONTEXT_INVALID`, same envelope with
  `correlationId`) for a non-member org, and `OrgSwitcher` catches it and
  shows a toast. Build new handlers the same way — a mock that only knows the
  happy path is how integration bugs stay hidden.
- **`/health` is not a contract endpoint.** It is served at the server root,
  outside `/v1`, absent from the contract and from your generated client. It
  has been removed from `endpoint-status.ts` and the promotion board.
- **Portal shells are actually gated** by organization type now. This is
  navigation hygiene only — the API guard and RLS are the real boundary, and
  you should never present it as security.
- **Supabase config fails loudly** outside mock mode instead of falling back
  to a placeholder key. The money lint ban now also covers
  `Number.parseFloat` and `globalThis.parseInt`.
- **There is a test runner**: `vitest` + Testing Library, `npm test -w web`.
  Phase 1 shipped with none. Add tests as you build this phase rather than
  deferring to Phase 9.

One correction to what you were told in Phase 1: a **missing**
`X-Organization-Id` returns `ORGANIZATION_CONTEXT_REQUIRED`, while a
malformed uuid and a non-member org both return
`ORGANIZATION_CONTEXT_INVALID`. Agent A's handoff note said all three were
identical. Only the second pair is — that pair is deliberately
indistinguishable so it cannot be used to enumerate organizations, and you
must not branch on the difference *within* it.

## Ports

The API owns 3000 (the frozen contract's servers block names it). Your dev
server is now **3001** — already wired into `npm run dev`.

## Then: Phase 2

Work the task list in `PHASE_2_ONBOARDING_GOVERNMENT.md`, mock-first as
always. Three things in it are where this phase goes wrong:

- **Government-derived fields are read-only, with a source badge (CCD / ISTD
  / GAM) and a retrieval date** — never editable inputs. Blank fields render
  neutrally, never as a deficiency.
- **`GOVERNMENT_SERVICE_UNAVAILABLE` renders as *paused, not adverse*.** "The
  source didn't answer" and "the source said something bad" must never look
  alike on screen — that distinction is one of the five defining behaviours
  and it is a demo scenario.
- **`APPROVED_CONDITIONAL` means login works but financing actions are
  blocked** (ZM-SON-011) — a banner plus genuinely disabled actions.

Everything else — hard rules, the frozen contract, the coordination
protocol, the completion-report gate — is unchanged from your standing
brief. End the session with `docs/completion/PHASE_2_AGENT_B.md`.
