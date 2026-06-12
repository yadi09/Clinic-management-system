# Delivery Roadmap — Phases 0–10

Each phase is a **vertical slice** (FE + BE + DB + permissions + tests) that is **deployable to staging and demonstrably valuable**. Phase mapping uses Part 2 module numbers (`internal/<module>`) and Part 1 FR groups. Blueprint module numbers refer to the 31-module catalogue (Part 1 Table 3.4).

---

## Phase 0 — Foundation
- **Goal:** Repo, dual app skeletons, Docker dev/staging/prod, Postgres + migrations, and the auth + multi-tenant + RBAC *kernel* so a developer/seed-user can log in and reach a protected, tenant-scoped area.
- **Scope (modules / FRs):** `kernel` (tenancy, auth, db, events/outbox, httpx, audit, storage, config); `identity` module foundation. Blueprint modules 1 (Auth), 3 (Role), 4 (Tenant - data model only), 30 (Audit - outbox + write path). FRs: FR-AUTH-01/02/03/04/05/06, FR-ROLE-01, FR-TEN-01 (states), NFR-12/13/14/17/22/23.
- **Key deliverables:** Monorepo + CI (lint, test, sqlc-stale check, import-boundary lint). Go `api`+`worker` binaries. React+Vite+TS+Tailwind+ShadCN shell with login/MFA pages. Migration tooling (goose) + first migration (tenants, plans, users, roles, permissions, role_permissions, user_role_scopes, sessions, audit_logs, feature_flags, event_outbox). RLS policies + `app.tenant_id` GUC wiring. JWT access+refresh with rotation, TOTP MFA, Argon2id hashing. Tenancy middleware + RLS net. `StorageProvider` interface + Cloudinary adapter. `/healthz`,`/readyz`,`/metrics`. Docker Compose (dev/staging/prod) + Caddy. Seed script (one tenant, one owner).
- **Dependencies:** None (greenfield).
- **Risks:** RLS + connection-pool GUC interaction (pgbouncer transaction mode + `SET LOCAL` must align) → mitigate by pinning GUC inside tx via `kernel/db.WithTx`. Auth security correctness → adopt vetted libs, security test in CI.
- **Success criteria:** A seeded user logs in (with MFA), receives rotating tokens, hits a protected `GET /api/v1/auth/me` returning role+scope+flags, and a cross-tenant probe (forged tenant in body) is rejected + audited. `docker compose -f compose.yml -f compose.dev.yml up` boots the full stack.

## Phase 1 — Core Clinic MVP
- **Goal:** First usable product — staff onboarding, clinic/branch/department setup, full patient registration/profile/search.
- **Scope:** `identity` (complete: invitations, lifecycle), `org` (clinics/branches/departments/resources), `patient` (registration, search, attachments, allergies/conditions, guardian links). Blueprint modules 2 (User Mgmt), 5/6/7 (Clinic/Branch/Dept), 8 (Patient Reg), 9 (Patient Search), 31 (Settings basic). FRs: FR-USR-01/02/03, FR-ROLE-01/02(Business), FR-TEN-02/03 (limits+flags enforced), FR-CLN-01, FR-BR-01/02, FR-DEP-01/02, FR-PAT-01..08, FR-SET-01, FR-AUD-01/02.
- **Key deliverables:** Onboarding wizard (clinic→branches→departments→users→flags→branding→go-live). User invite flow (email link). RBAC enforcement middleware (role+scope+flag) live on every route. Patient 3-step registration wizard with **real-time duplicate detection** (FR-PAT-03 via pg_trgm). Patient search (`pg_trgm` + FTS, NFR-03 <400ms). Attachment upload via Cloudinary presign. Feature-flag resolver + UI gating (hide module / upgrade prompt). Plan-limit enforcement (block-with-upgrade).
- **Dependencies:** Phase 0 kernel.
- **Risks:** Duplicate-detection false-positive rate annoying front desk → tune trigram threshold, warn-not-block. Plan-limit enforcement scattered → centralize in a `limits` service in `identity`.
- **Success criteria:** Self-onboard a tenant to first patient registered in **< 15 min** (US-01, KPI). Registration **< 90s** (NFR-19). Duplicate warning fires on name+DOB+phone match. Branch-scoped user cannot see other branch's patients (audited deny).

## Phase 2 — Appointments & Queue
- **Goal:** Schedule visits and run a live department queue.
- **Scope:** `scheduling` (slots, appointments, queue_entries). Blueprint modules 10 (Appointments), 11 (Queue). FRs: FR-APT-01/02/03/04, FR-QUE-01/02/03, NFR-04 (<2s propagation).
- **Key deliverables:** Provider/resource day/week/month calendar with drag-to-create/reschedule; double-booking prevention. Cancel/reschedule with reason+history. Live queue board (waiting→called→in_consult→done→no_show) with priority/triage override. **Real-time transport: SSE backed by Postgres LISTEN/NOTIFY** (Redis decision point — add only if >1 API replica needed). Appointment reminders (email/SMS) via outbox→worker. Portal self-booking stub (constrained to availability).
- **Dependencies:** Phase 1 (patients, branches, departments, providers).
- **Risks:** Real-time propagation under load / reconnection storms → SSE with heartbeat + client backoff; promote to Redis pub/sub if multi-replica. Double-booking races → DB unique/exclusion constraint on (resource, time-range).
- **Success criteria:** Queue state visible to all staff within 2s. No double-booking of a resource. Reminder enqueued on booking.

## Phase 3 — Consultation & EMR
- **Goal:** Full clinical encounter: SOAP notes, vitals, ICD diagnoses, prescriptions, specialty dynamic forms; immutable-once-signed; auto-charge on close.
- **Scope:** `clinical` (encounters, clinical_notes, vitals, diagnoses, procedures, referrals, follow_ups, prescriptions, prescription_items, form_templates/versions/submissions). Blueprint modules 12–19 + form builder. FRs: FR-CON-01/02, FR-EMR-01..06, FR-RX-01..04, FR-FRM-01..06, NFR-15.
- **Key deliverables:** Encounter workspace (patient banner + allergy alerts + section rail + history timeline). SOAP editor with auto-save, sign-and-lock (immutable; amendments tracked). Vitals capture + trend charts. ICD diagnoses. Prescription with **allergy-conflict block** (FR-RX-02, 422 rule_violation). Dynamic form builder (versioned JSON schema) + runtime renderer (Zod-on-the-fly). `EncounterClosed` event via outbox → charge creation (Phase 7 consumes; stub charge row now) + notification. Specialty EMR sections (odontogram/growth chart/per-eye) behind department config.
- **Dependencies:** Phases 1–2 (patient, encounter source from queue/appointment).
- **Risks:** Form-builder scope creep (it's a mini-product) → ship field types + versioning first, conditional logic second. Immutability + amendment integrity → enforce in service layer + DB (no UPDATE on signed notes).
- **Success criteria:** Sign-and-close locks the note and emits `EncounterClosed`; prescribing a penicillin to an allergic patient is blocked + audited; ≥95% encounters documented completely (KPI).

## Phase 4 — Laboratory (LIS)
- **Goal:** Order labs from encounter, process samples, enter/validate/approve results, release to provider/portal.
- **Scope:** `laboratory` (test_groups, tests, orders, order_items, samples, results). Blueprint module 20, flag `laboratory`. FRs: FR-LAB-01..07.
- **Key deliverables:** Test catalog (specimen, units, age/sex-aware reference ranges, price). Lab orders from encounter. Sample lifecycle (ordered→collected→received→in_process→resulted) with barcodes. Result entry (manual + CSV import; device/HL7 as seam). Result lifecycle entered→validated→approved with role-gated transitions (tech enters, manager approves). `LabResultApproved` event → attach to encounter + notify + lab charge. Feature-flag gating end-to-end (403 feature_disabled when off).
- **Dependencies:** Phase 3 (encounter to order from), flag system (Phase 1).
- **Risks:** HL7/ASTM device integration depth → defer to a `LabDevicePort` interface, CSV import covers MVP. Result state authorization bugs → table-test the role gates.
- **Success criteria:** Tech-without-approve-permission cannot approve (denied+audited, state unchanged); approved result appears on ordering encounter and (if released) portal.

## Phase 5 — Pharmacy
- **Goal:** Dispense against prescriptions + OTC, batch/expiry control, purchasing.
- **Scope:** `pharmacy` (drugs, drug_batches, suppliers, purchase_orders, po_items, goods_receipts, dispenses, dispense_items, otc_sales). Blueprint module 21, flag `pharmacy`. FRs: FR-PHA-01..06. **Redis re-evaluation point** (still likely not needed). **First candidate for a real RabbitMQ consumer if inventory decrement fan-out grows — still deferred.**
- **Key deliverables:** Drug catalog (+trigram search). Batch stock with expiry; **FEFO** dispensing; block expired/insufficient. Dispense against signed Rx + OTC sale. `MedicationDispensed` event → pharmacy charge + inventory decrement + audit. Suppliers/PO/goods-receipt/returns. Low-stock + near-expiry alerts (scheduler in worker).
- **Dependencies:** Phase 3 (prescriptions), Phase 7 partial (charges) — emit event now, finance consumes.
- **Risks:** Stock concurrency (two dispenses, one batch) → row-lock batch on decrement. Idempotent dispensing (Part 4 §10.10 Idempotency-Key) → enforce.
- **Success criteria:** Dispense from earliest-expiry batch; expired-only stock blocks dispense with clear reason, no decrement (FR-PHA-02 acceptance).

## Phase 6 — Inventory
- **Goal:** Non-drug stock, inter-branch transfers, purchasing, stock counts.
- **Scope:** `inventory` (inventory_items, stock_levels, stock_transfers, purchase_requests, stock_counts). Blueprint module 22, flag `inventory`. FRs: FR-INV-01..04.
- **Key deliverables:** Item catalog (SKU, UoM, reorder level). Per-branch stock levels. Inter-branch transfer (requested→dispatched→received). Purchase requests→orders→receipts. Stock counts with variance. Reorder suggestions (scheduler).
- **Dependencies:** Phase 1 (branches), shares purchasing patterns with Phase 5.
- **Risks:** Transfer state consistency across branches → single transactional state machine; both branches see same row. Drug vs non-drug overlap in purchasing → keep `po_items` polymorphic (drug_id OR item_id) per schema.
- **Success criteria:** Transfer dispatched from A is receivable at B with on-hand reflecting both sides; variance reported on count.

## Phase 7 — Billing
- **Goal:** Aggregate charges across consultation/lab/pharmacy/procedures into invoices; payments, refunds, reconciliation; (insurance prepared but flag-gated).
- **Scope:** `finance` (charges, invoices, invoice_lines, payments, refunds, price_lists, discounts; insurance_providers/coverage_plans/claims/claim_items/reimbursements behind flag). Blueprint modules 23/24/25 (Core) + 26 (Insurance, flag). FRs: FR-BIL-01/02, FR-INVC-01, FR-PAY-01/02/03, FR-INS-01..04.
- **Key deliverables:** Charge consumers for `EncounterClosed`/`LabResultApproved`/`MedicationDispensed` (now do real work — the events emitted since Phase 3 light up). Invoice assembly (draft→issued→partially_paid→paid→void). Payments (cash/card/gateway/insurance) **idempotent** (Idempotency-Key). Refunds (approval-gated). Daily cash-up/reconciliation. Price lists per branch, discounts with approval. Insurance claim lifecycle (prepared→submitted→approved/rejected→reimbursed) behind `insurance` flag. Money DTO (NUMERIC store ↔ minor-unit API).
- **Dependencies:** Phases 3/4/5 (charge sources via events). This is where the outbox seam pays off.
- **Risks:** Charge duplication on event redelivery → idempotent consumers keyed on (event_id) + (source, source_ref) unique. Money rounding → NUMERIC everywhere, round only at display.
- **Success criteria:** Visit charges from consult+lab+pharmacy aggregate to one invoice (US-09); ≥99% billed-vs-rendered capture (KPI); payment idempotent on retry.

## Phase 8 — Reporting & Analytics
- **Goal:** Role-based operational/financial dashboards + exportable reports.
- **Scope:** `platform` (reports, analytics snapshots, notifications already live). Blueprint modules 27 (Notifications - mature), 28 (Reporting), 29 (Analytics). FRs: FR-REP-01, FR-ANL-01/02, FR-NOT-01.
- **Key deliverables:** Per-role dashboards (reception/doctor/nurse/lab/pharmacy/finance/management) with KPIs. Operational + financial reports with filters, CSV/PDF export (export = 202 + job, polled). Multi-branch consolidated analytics with drill-down (FR-ANL-02). Reports run as worker jobs reading Postgres (and read-replica later). Report files stored via StorageProvider.
- **Dependencies:** Phases 1–7 (data to report on).
- **Risks:** Heavy report queries degrading request latency → run in worker off-peak / read-replica; never in API path. PDF generation memory → stream/paginate.
- **Success criteria:** Each role lands on its dashboard with live KPIs; consolidated revenue with per-branch drill-down (US-10); CSV/PDF export delivered async.

## Phase 9 — Multi-Branch
- **Goal:** Harden true multi-branch operation: branch-scoped access everywhere, shared catalogues with overrides, consolidated finance, inter-branch transfers (built P6) operationalized.
- **Scope:** Cross-cutting hardening of `org`, `finance`, `inventory`, `scheduling`, `patient` (one MRN/tenant across branches). Blueprint module 6 maturity + scoping rules §3.7.2. FRs: FR-BR-02, FR-PAT-08, FR-ANL-02, NFR-13 at branch granularity.
- **Key deliverables:** Branch scope switcher session-wide (scopes data+defaults+permissions). Central catalogues (services/drugs/tests/forms) + branch overrides. Consolidated finance preserving per-branch P&L. Branch-manager scoping audited. One MRN shared across branches, operational visibility scoped.
- **Dependencies:** Phases 1–8 (all domains must respect branch scope before consolidation).
- **Risks:** Retrofitting branch scope reveals gaps → scope was enforced from Phase 1, so this is hardening + audit, not rework. Catalogue override resolution complexity → explicit resolution order (branch override → tenant default).
- **Success criteria:** Branch Manager A denied Branch B data (audited); patient registered at branch 1 visible (scoped) at branch 2 under same MRN.

## Phase 10 — Advanced SaaS
- **Goal:** Commercialize the platform: subscriptions, usage metering/limits, tenant billing, feature-flag maturity, plus deferred enterprise seams.
- **Scope:** `platform` + new `billing-platform` surface on admin host. Blueprint module 4 (Tenant Mgmt/subscription billing - full), commercial model (Part 1 §3.2). FRs: FR-TEN-02/03/04 (full), plan tiers, dunning, impersonation (FR-AUTH-07).
- **Key deliverables:** Subscription lifecycle (trialing→active→past_due→cancelled) + payment gateway. Usage metering (visits/API/storage/SMS) vs plan limits + alerts. Tenant invoicing + dunning + suspension automation. Feature-flag rollout/overrides (plan default→addon→override). SaaS-support impersonation (consented, time-boxed, read-only, audited - FR-AUTH-07). **Deferred-infra promotions decided HERE if scale warrants:** SSO/OIDC, RabbitMQ, Redis, OpenSearch, observability stack, K8s. Tenant data-retention/purge on cancellation (FR-TEN-04).
- **Dependencies:** All prior phases + real customers/usage data to justify infra promotions.
- **Risks:** Premature infra promotion → gate each on documented trigger conditions (ADR-001). Billing/dunning correctness → idempotent + heavily tested + sandbox gateway.
- **Success criteria:** Trial→paid conversion measurable (≥25% KPI target); past-due tenant auto-suspended with data retained; consented impersonation fully audited; plan-limit breach blocks with upgrade prompt.
