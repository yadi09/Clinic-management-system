# Phase 1 — Core Clinic MVP · Completion Report

**Date:** 2026-06-12 · **Status:** ✅ Complete (incl. staff invitation & user management)

## Phase goal
A clinic can set up its profile/branches and **register and manage patients** — the first usable product.

## Completed & verified

**Database** — migration `00003` (clinics, branches, departments, resources; patients + allergies/conditions/attachments/guardian_links; user_invitations; per-tenant `mrn_counters`). RLS ENABLE+FORCE + `tenant_isolation` on every new table. `pg_trgm` GIN + generated `tsvector` for patient search. App-role grants extended.

**RBAC enforcement** — access token now carries roles **+ permissions + flags**; `RequirePermission`, `RequireRole`, `RequireFlag` middleware gate every protected route (NFR-13, FR-TEN-03). Loaded at token issue from the user's role grants.

**Patient module** (`internal/patient`) — register with **duplicate detection** (name+DOB / phone / national-id; 409 + matches unless `force`), per-tenant MRN allocation, `PatientRegistered` event → audit; **search** (FTS + trigram, paginated); full **profile** (demographics + allergies + conditions + attachments + guardians); update; soft-delete; allergies/conditions CRUD; **attachments via Cloudinary presign** (`/attachments/sign` → direct upload → `/attachments` record) + delete; guardian links. All routes permission-gated.

**Org module** (`internal/org`) — clinic profile (upsert), branches (CRUD), departments (CRUD), resources (CRUD). Reads open to staff; mutations require `clinic.manage`.

**Frontend** — sidebar app shell (permission-gated nav); **Patients**: searchable list, register wizard with duplicate-warning modal, profile with allergy/condition add-remove and allergy alerts; **Settings**: clinic name, branches, departments. Auth context now exposes `can`/`hasRole`/`flagOn` from `/auth/me`. API client surfaces pagination `meta` and error `body` (duplicate matches).

**Seed** — demo tenant now also gets a clinic + "Main Branch".

| Check | Result |
|---|---|
| `go build`/`vet`/`test -short` | ✅ |
| `importlint` (org & patient only touch kernel + own ports) | ✅ |
| `sqlc generate` (3 packages, no drift) | ✅ |
| Frontend `tsc` + `vite build` | ✅ (105 KB gz) |
| RLS / search / dedup runtime behaviour | ⏳ runs via Docker/CI (no daemon in this sandbox) |

## API added (all under `/api/v1`, RequireAuth)
`GET/PUT /org/clinic` · `GET/POST/PUT/DELETE /org/branches[/:id]` · `…/departments[/:id]` · `…/resources[/:id]` · `POST/GET/PUT/DELETE /patients[/:id]` (search, register, profile, update, delete) · `…/patients/:id/allergies[/:sid]` · `…/conditions[/:sid]` · `…/guardians` · `…/attachments/sign` · `…/attachments[/:sid]`.

## Staff invitation & user management (now complete)
- **`NotificationProvider`** abstraction (`kernel/notify`) with a dev **log adapter**; real email/SMS slots in later (Q3 deferred — "decide later, keep abstraction").
- **Invite flow:** `POST /users` creates an invited account, assigns roles, enforces the plan's **active-user limit** (FR-USR-03), and returns a **copyable invite link** (also "sent" via the log provider). `POST /auth/accept-invite` validates the token (tenant-prefixed, hashed, expiring), sets the Argon2id password, activates the account (re-checking the limit), and signs the user in.
- **Management:** `GET /users` (with roles), `POST /users/:id/status` (suspend/reactivate/deactivate — FR-USR-02), `PUT /users/:id/roles`, `GET /roles` — all permission-gated (`user.invite`/`user.read`/`user.update`/`role.assign`).
- **Frontend:** Staff page (list, invite modal showing the link, suspend/reactivate) + public Accept-Invite page (set password → auto sign-in).

## Technical debt / notes
- Patient `address`/`emergency_contact` and branch `opening_hours` stored as JSONB but written via `::jsonb` casts (string params) — see sqlc overrides.
- Attachment upload is real (Cloudinary presign) once `CLOUDINARY_*` env is set; dev without keys uses the no-op provider (sign returns an error).
- No automated frontend tests yet (Vitest harness recommended next).

## Recommended next step
Phase 1 is fully closed. Proceed to **Phase 2 — Appointments & Queue** (scheduling, double-booking prevention, live queue board via SSE + Postgres LISTEN/NOTIFY, reminders through the now-existing `NotificationProvider`). A real email/SMS provider (Q3) can be wired then.
