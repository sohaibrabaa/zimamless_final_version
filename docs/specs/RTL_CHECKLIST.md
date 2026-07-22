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
