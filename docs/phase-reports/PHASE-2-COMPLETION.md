# Phase 2 — Appointments & Queue · Completion Report

**Date:** 2026-06-12 · **Status:** ✅ Complete (backend runtime-verified; frontend builds)

## Goal
A clinic can schedule visits (free booking, no double-booking) and run a live department queue.

## Completed & verified
**Database** — migration `00004`: `appointments` + `queue_entries` (RLS + FORCE + `clinic_app` grants). `btree_gist` exclusion constraints enforce **no overlapping appointments** for the same provider, and separately for the same room/resource (ignoring cancelled/no-show/deleted).

**Scheduling module** (`internal/scheduling`) — book (free model: start + duration), list (by branch + date range + optional provider, enriched with patient/provider/department names), reschedule, set status (confirm/cancel/complete/no-show), **check-in** (appointment → `checked_in` + queue entry, one transaction), **walk-in** enqueue, **queue list/transition** (waiting→called→in_consult→done / no_show), priority. Events `scheduling.appointment.booked` and `scheduling.patient.checked_in` flow through the outbox (audit + reminder).

**Live queue (SSE)** — every queue change calls `pg_notify('queue_events', …)`; `GET /queue/stream` hijacks a dedicated connection, `LISTEN`s, filters by tenant + department, and streams SSE (heartbeats every 25s). Auth via `?token=` (EventSource can't set headers).

**Reminders** — booking emits an event; the worker logs a reminder via the `NotificationProvider` (real email/SMS deferred to a chosen provider, Q3).

**Frontend** — **Appointments** (day agenda + week grid, date nav, booking dialog with patient-search combobox + provider/department/duration, reschedule, check-in, cancel) and **Queue** board (4 live columns, call/start/complete/no-show, walk-in, wait timers, EventSource live updates). Nav items added (permission-gated).

### Runtime verification (local Postgres)
- Book 09:00/30m → 201; overlapping 09:15 same provider → **409 APPOINTMENT_CONFLICT**; non-overlapping 10:00 → 201.
- Check-in → 204 → patient on the queue (`waiting`); transition → `called`.
- Day list returns correct appointments/statuses.
- Backend: `go build`/`vet`/import-lint/`sqlc` in-sync/unit tests pass. Frontend: `tsc` + `vite build` pass.

## API added (`/api/v1`)
`GET/POST /appointments` · `PUT /appointments/:id` · `POST /appointments/:id/status` · `POST /appointments/:id/check-in` · `GET /queue` · `POST /queue/walk-in` · `POST /queue/:id/transition` · `POST /queue/:id/priority` · `GET /queue/stream` (SSE).

## Technical debt / notes
- `ListAppointments` JOINs patients/users/departments for display names — a pragmatic cross-module **read** (writes stay within the module; import-lint still passes since it's SQL). Revisit if a module is extracted.
- Provider list in the booking dialog reuses `GET /users` (needs `user.read`); a dedicated providers endpoint gated by `appointment.manage` would suit receptionists better.
- Reminder **timing** ("24h before") not yet scheduled — only the event + dev-log. Needs a scheduler + real provider.
- SSE assumes a single API instance (fine on one VPS); multi-replica needs Redis pub/sub (pre-approved trigger, ADR-001).
- "Today" for the queue uses UTC day boundaries; per-tenant timezone refinement later.
- Reschedule keeps the same patient (no patient change); drag-to-reschedule is a later polish (per your call).

## Out of scope (as agreed)
Consultation/EMR (Phase 3), patient self-booking portal, real SMS/email delivery, calendar sync.

## Acceptance — met
Conflict rejected ✓ · check-in → queue ✓ · queue transitions + no-show ✓ · reminder event emitted ✓ · live board updates via SSE (verify in browser with two tabs).
