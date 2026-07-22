# RTL Checklist (Agent B)

Owner: Agent B (Master Plan Part 2). Rules established Phase 1; executed screen-by-screen — every screen, not a sample — in Phase 9 (brief §6, Master Plan 5.6).

## Standing rules (apply from Phase 1 onward, not retrofitted)

1. **No hardcoded `dir="rtl"` sprinkling.** Direction is set once, on `<html dir>`, in `app/[locale]/layout.tsx`, derived from the locale segment. Never set `dir` again except for a deliberate LTR island (see #4).
2. **Logical CSS properties only.** Use `ms-*`/`me-*` (margin-inline-start/end), `ps-*`/`pe-*` (padding-inline-start/end), `start-*`/`end-*`, `text-start`/`text-end`, `rounded-s-*`/`rounded-e-*`. Never `ml-*`/`mr-*`/`pl-*`/`pr-*`/`left-*`/`right-*`/`text-left`/`text-right` in app code — those hardcode a physical direction that RTL will render backwards.
3. **Column and nav order follows document order.** Never build a "reversed for RTL" array — the browser mirrors document-order content automatically under `dir="rtl"`. See `components/ui/Table.tsx` and `components/layout/PortalShell.tsx` nav for the pattern.
4. **Bidi islands: IBANs, IDs, Latin names, and money inside Arabic text stay LTR-isolated.** Use the `.zm-ltr-embed` utility (`app/[locale]/globals.css`) — `direction: ltr; unicode-bidi: isolate`. `components/money/MoneyDisplay.tsx` already applies this; any other embedded Latin/numeric string (national ID, IBAN, invoice number) needs the same treatment.
5. **Icons that imply direction (arrows, chevrons, back/forward) must mirror.** Icons that don't imply direction (checkmarks, bell, trash) must not. When adding icon components in later phases, tag each as directional or not.
6. **Keyboard navigation is direction-aware only where the browser already handles it.** `Tabs.tsx`'s ArrowLeft/ArrowRight only ever advance/retreat the tab index — never swap which physical arrow means "next" ourselves; letting `dir` do the mirroring is what keeps it correct in both languages without a special case.
7. **Forms flow top-to-bottom, fields right-to-left in Arabic** — this is automatic from logical properties + `dir`, but must be visually verified per screen (see below), since a fixed-width layout or an absolutely-positioned decoration can silently break it.
8. **No message key may exist in only one locale.** CI-worthy check (Phase 1 exit bar candidate): every key in `messages/en.json` must exist in `messages/ar.json` and vice versa.

## Per-screen verification (Phase 9 — every screen)

For each screen, in Arabic, verify:

- [ ] Layout mirrors: nav/sidebar on the visual right, content flows right-to-left
- [ ] Table column order matches Arabic reading order (first column visually rightmost)
- [ ] Icons that imply direction are mirrored; non-directional icons are not
- [ ] Progress indicators (steppers, countdowns, SLA bars) fill in the mirrored direction
- [ ] Modals, toasts, and dropdowns anchor to the correct (mirrored) edge
- [ ] IBANs, establishment numbers, invoice numbers, and money render LTR-isolated and don't visually reorder
- [ ] Form tab order follows the mirrored visual order, not the DOM order blindly
- [ ] No truncated or overlapping Arabic text (longer average string length than English)
- [ ] Focus outlines and keyboard navigation follow the mirrored visual order
- [ ] Screen-reader labels are the Arabic strings, not leftover English

## Known deliberate exceptions

- Money, IBANs, national IDs, invoice numbers, Latin company/person names: always LTR-isolated inside Arabic text (`.zm-ltr-embed`) — this is correct, not a bug.
- `MoneyInput` (`components/money/MoneyInput.tsx`) is hardcoded `dir="ltr"` regardless of locale — decimal input behavior must not flip.

## Status

Phase 1 screens covered by the standing rules above: login, register, verify-email, verify-phone, all three portal dashboards, all stub nav destinations. No dedicated per-screen pass yet — that's Phase 9's job per the Master Plan; this file will grow a per-screen sign-off table as real screens land in Phases 2–8.

### Rule #8 is now enforced, not just stated

`npm run check:i18n` (`apps/web/scripts/check-i18n-parity.mjs`) fails the build if any key exists in one locale and not the other. This matters more than it looks: `useTranslations` falls back to returning the key itself, so a missing Arabic string renders as `onboarding.sla.pausedTitle` on screen rather than throwing. Wired into `npm run check` alongside lint and tests. Currently 256 keys, both locales.

## Phase 2 screens — built RTL-ready (Phase 9 still verifies)

Per the standing rules, not retrofitted. What each screen needed beyond the defaults:

| Screen | RTL-specific handling |
|---|---|
| Supplier bootstrap form | Establishment + licence number inputs forced `dir="ltr"` (rule #4) — numeric identifiers must not reorder in Arabic |
| Onboarding wizard (4 steps) | `WizardStepper` renders steps in document order with `ms-*` connectors, so the strip mirrors without a per-locale reversed array (rules #2, #3) |
| Government field list | Every retrieved value wrapped in `.zm-ltr-embed` — company numbers, tax numbers, IBANs and Latin company names inside Arabic labels (rule #4) |
| SLA tracker | Progress bar sized with `inlineSize`, not `width`, so it fills from the mirrored edge (rule #7 / progress indicators) |
| Information-request inbox | Textarea inherits page direction (free Arabic text is correct RTL); status badges use logical spacing |
| Reviewer queue table | Columns in document order via `components/ui/Table.tsx`; establishment-number cell LTR-isolated; SLA column `align: "end"` |
| Application detail | Same government components as the supplier side; back-link chevron is the text `←`, **flagged as a directional glyph needing mirroring in the Phase 9 pass** |
| Ineligibility notice | Reference number LTR-isolated |

Known item for the Phase 9 pass: the `←` back-link on the application detail screen is a literal character, not an icon component, so it does not mirror. Rule #5 says directional glyphs must mirror; this needs either a mirrored icon component or a logical-property replacement when the icon system lands.
