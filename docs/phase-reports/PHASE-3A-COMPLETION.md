# Phase 3a — Reception & Routing · Completion Report

**Date:** 2026-06-12 · **Status:** ✅ Built & runtime-verified on local Postgres (as `clinic_app`, RLS enforced). Frontend builds (tsc + vite). **Awaiting product-owner sign-off before commit.**

## Goal
Turn the workflow's front-desk segment into a working slice: the **card / consultation fee** (the appointment-gated "free follow-up" rule), an optional **triage** step with **vitals**, **doctor assignment**, and a **per-doctor worklist**. See [docs/patient-workflow.md](../patient-workflow.md).

## Delivered

**Database** — migration `00005`: clinic flow settings on `clinics` (`card_fee_enabled`, `card_fee_amount`, `card_currency`, `free_window_days`, `triage_required`, `doctor_assignment`); appointment coverage flags (`is_followup`, `free_until`); `queue_entries` gains `stage` (`triage`/`with_doctor`) + `assigned_provider_id`; new tables `card_payments`, `encounters` (the visit spine, one per queue entry), `vitals`. RLS + FORCE + `clinic_app` grants on all new tables.

**Billing module** (`internal/billing`, new) — the card fee:
- `Assess` decides pay/free. Order: card disabled → free; **already paid today** → free; **doctor-booked follow-up within `free_until`** → free; otherwise **pay**. A self-initiated walk-in (no appointment) always pays.
- `Collect` records a receipt (or a waiver with reason); emits `billing.card.paid`.
- `History` lists a patient's receipts.

**Clinical module** (`internal/clinical`, new) — the visit spine:
- `RecordVitals` lazily opens the encounter for a queue entry, then appends a vitals row (emits `clinical.vitals.recorded`).
- `GetVisit` returns the encounter + vitals for a queue entry.

**Scheduling module** (extended):
- Check-in / walk-in now route by **stage** (to triage, or straight to a doctor — defaulting to the appointment's provider).
- `AssignProvider` routes a queue entry to a doctor (→ `with_doctor` stage).
- `ListWorklist` — a doctor's "patients waiting for me".
- `ListQueue` gains a `stage` filter (the triage board uses `stage=triage`).
- `MarkFollowup` flags an appointment as a covered follow-up (3b's doctor booking will set this automatically).

**Org module** (extended) — `GET/PUT /org/settings` for the flow configuration.

**Frontend** — **Reception** (patient search → card-status banner → Collect/Waive → route to triage or a doctor), **Triage** board (vitals dialog + assign-doctor), **My worklist** (per-doctor list with call/start/complete), and a **Patient flow** card in Settings. Nav + routes added (permission-gated).

**Permissions** (seed) — added `payment.collect` and `triage.manage` (`encounter.manage` already existed and gates the worklist).

## API added (`/api/v1`)
`GET/PUT /org/settings` · `GET /billing/card/assess` · `POST /billing/card/collect` · `GET /billing/card/history` · `POST /appointments/:id/followup` · `POST /queue/:id/assign` · `GET /queue?...&stage=` · `GET /worklist` · `GET /visits/:qid` · `POST /visits/:qid/vitals`.

## Runtime verification (local PG, `clinic_app`)
Settings round-trip (numeric → string `150.00`) ✓ · walk-in assess → **card fee due** ✓ · collect → receipt ✓ · re-assess → **already paid today** ✓ · walk-in → **triage** stage ✓ · record vitals ✓ · **assign doctor** → patient leaves triage, appears on the doctor's **worklist** ✓ · book appt + mark follow-up → assess **covered follow-up (free)** ✓ · same patient as a walk-in → **card fee due** ✓ (proves the appointment-gated rule).

Backend `go build`/`vet`/importlint/unit tests pass; sqlc in-sync; frontend `tsc` + `vite build` pass.

## Module-boundary notes
- `billing.Assess` reads `clinics` + `appointments` via SQL (cross-module **read**; writes stay in `billing`) — same pragmatic pattern as `scheduling.ListAppointments`.
- The reception flow is orchestrated by the **frontend** (assess/collect → enqueue → vitals → assign) so no module opens a transaction across another's tables.
- `numeric` columns map to Go `string` (sqlc override `pg_catalog.numeric`) to avoid `pgtype.Numeric` churn; money stays exact.

## Out of scope (→ 3b and later)
The consultation/EMR encounter (SOAP, diagnosis, prescription, sign-and-lock, follow-up booking by the doctor, referral) is **Phase 3b**. Per-department prepay gates, lab price lists, pharmacy, and full billing are later phases.

## How to test in Docker
1. Apply the migration (runs as superuser): `docker compose run --rm migrate up` (or restart the migrate service).
2. Re-seed to grant the owner the new permissions: `docker compose run --rm api /app/seed`.
3. Rebuild the frontend image (new pages/nav).
4. Log in as the owner → new **Reception**, **Triage**, **My worklist** nav items + the **Patient flow** card in **Settings**.

## Fix bundled in
`cmd/migrate` no longer panics when invoked with no sub-command (defensive `os.Args` guard).
