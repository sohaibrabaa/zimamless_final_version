# Endpoint Status — mock → live promotion board

Mirror of `apps/web/lib/api/endpoint-status.ts`. Agent A flips **Announced live** when deployed; Agent B flips **B status** to `live` only after a same-day smoke test on the consuming screen. Demo-path endpoints must all be `live` before the Phase 9 rehearsal.

Legend: `mock` = MSW mock · `live` = real API, smoke-passed · `n/a` = not yet generated.

`GET /health` is deliberately **not** on this board. It is served outside the
`/v1` prefix, excluded from the frozen contract and from `/docs-json`, and so
never appears in the generated client — it is infrastructure, not a contract
endpoint, and has no mock→live promotion to track.

| Endpoint | Phase | Announced live (A, date) | B status | Notes |
|---|---|---|---|---|
| GET /auth/me | 1 | — | mock | demo flag (D-10) included |
| POST /auth/context | 1 | — | mock | |
| PATCH /auth/language | 1 | — | mock | |
| POST /onboarding/register * | 2 | — | mock | v3.1.0 · consumed by supplier bootstrap form |
| GET /onboarding/applications-list * | 2 | — | mock | v3.1.0 · supplier onboarding home + reviewer queue |
| POST /onboarding/applications | 2 | — | mock | no screen consumes it — bootstrap (D-04) covers the supplier path |
| GET /onboarding/applications/{id} | 2 | — | mock | reviewer application detail |
| POST …/{id}/submit | 2 | — | mock | wizard step 4 |
| POST …/{id}/bank-account | 2 | — | mock | wizard step 4 |
| POST …/{id}/consents | 2 | — | mock | wizard step 3 · **consent catalogue provisional, see Q-09** |
| GET …/{id}/information-requests | 2 | — | mock | info-request inbox (both portals) |
| POST …/{id}/respond | 2 | — | mock | supplier response form |
| POST …/{id}/decide | 2 | — | mock | reviewer decision form · **reason-code catalogue provisional, see Q-06** |
| POST /government/lookup | 2 | — | mock | handler exists; no screen triggers a manual lookup yet |
| GET /government/requests/{id} | 2 | — | mock | handler exists; source panel reads the list on the application instead (Q-08) |
| GET /buyers/search | 3 | — | mock | |
| POST /buyers/resolve | 3 | — | mock | |
| GET /buyers/{id} | 3 | — | mock | |
| POST /documents/upload-url | 3 | — | mock | |
| GET /documents/{id}/download-url | 3 | — | mock | |
| GET /documents/{id}/extraction | 3 | — | mock | |
| GET/POST /transactions | 3 | — | mock | |
| GET /transactions/{id} | 3 | — | mock | |
| PUT …/{id}/invoice | 3 | — | mock | |
| PUT …/{id}/buyer | 3 | — | mock | |
| PUT …/{id}/minimum-amount | 3 | — | mock | |
| POST …/{id}/declarations | 3 | — | mock | |
| POST …/{id}/submit | 3 | — | mock | |
| GET …/{id}/verification | 3 | — | mock | |
| GET …/{id}/risk | 4 | — | mock | |
| GET/POST /admin/risk-models | 4 | — | mock | |
| POST …/{id}/listing | 5 | — | mock | |
| GET …/{id}/listing-current * | 5 | — | mock | v3.1.0 |
| GET /listings/{id} | 5 | — | mock | |
| GET /listings/{id}/offers | 5 | — | mock | role-split |
| GET /marketplace/eligible | 5 | — | mock | |
| GET /marketplace/listings/{id} * | 5 | — | mock | v3.1.0 |
| GET/POST /banks/policy-filters | 5 | — | mock | |
| PATCH /banks/policy-filters/{id} * | 5 | — | mock | v3.1.0 |
| POST /listings/{id}/offers/create | 5 | — | mock | |
| GET /offers * | 5 | — | mock | v3.1.0 |
| GET/PATCH /offers/{id} | 5 | — | mock | |
| POST /offers/{id}/approve | 5 | — | mock | |
| POST /offers/{id}/withdraw | 5 | — | mock | |
| POST /offers/{id}/accept | 6 | — | mock | DEMO-CRITICAL |
| POST /listings/{id}/reject-all | 6 | — | mock | |
| POST/GET …/{id}/contract | 6 | — | mock | |
| POST /contracts/{id}/sign | 6 | — | mock | |
| GET …/{id}/conditions | 6 | — | mock | |
| POST /conditions/{id}/fulfil | 6 | — | mock | |
| POST …/{id}/funding/mark-sent | 7 | — | mock | |
| POST …/{id}/funding/otp | 7 | — | mock | |
| POST …/{id}/funding/confirm | 7 | — | mock | |
| GET …/{id}/settlement | 7 | — | mock | |
| POST /settlements/{id}/retry | 7 | — | mock | |
| GET/POST …/{id}/payments | 8 | — | mock | |
| POST …/{id}/confirm-status | 8 | — | mock | |
| POST …/{id}/close | 8 | — | mock | |
| POST …/{id}/recourse · GET/status/repay /recourse/{id} | 8 | — | mock | partly v3.1.0 |
| POST …/{id}/disputes · resolve * | 8 | — | mock | |
| POST /offers/{id}/withdrawal-case · decide * | 8 | — | mock | |
| POST …/{id}/fraud-review · decide * | 8 | — | mock | |
| GET /cases * | 8 | — | mock | v3.1.0 |
| POST …/{id}/relist-request * | 8 | — | mock | v3.1.0 |
| POST …/{id}/cancel * | 8 | — | mock | v3.1.0 |
| GET /notifications · POST read * | 8 | — | mock | v3.1.0 |
| GET/PATCH /admin/settings | 9 | — | mock | |
| GET/POST /admin/commission-tiers | 9 | — | mock | |
| GET /admin/audit-logs | 9 | — | mock | |
| GET /admin/relisting-requests · approve | 9 | — | mock | partly v3.1.0 |
| POST /demo/time-travel | 9 | — | mock | DEMO-CRITICAL |
