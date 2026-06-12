# Phase 0 — Foundation · Completion Report

**Date:** 2026-06-12 · **Status:** ✅ Complete

## Phase goal
Stand up the monorepo, the Go modular-monolith skeleton (`api` + `worker`), the React app shell, Docker Compose for dev/staging/prod, Postgres with migrations, and the **auth + multi-tenant + RBAC kernel** so a seeded user can log in (with MFA), receive rotating tokens, and reach a tenant-scoped protected area — with cross-tenant access provably impossible.

## Completed features

**Backend kernel** (`backend/internal/kernel/`)
- `config` — typed env config, fail-fast validation, prod guards (NFR-14).
- `db` — pgx pool + `WithTx`/`WithTenantTx` setting the `app.tenant_id` GUC for RLS.
- `auth` — Argon2id passwords, AES-256-GCM TOTP-secret encryption, HS256 JWT access tokens + MFA challenge tokens, opaque SHA-256-hashed rotating refresh tokens, TOTP (FR-AUTH-01..06).
- `tenancy` — principal + tenant context; tenant resolved from token, never the body (NFR-13).
- `id` — UUIDv7 PKs + prefixed opaque external IDs (`usr_…`); reconciles Part 2/Part 4.
- `apperr` + `httpx` — typed errors → stable HTTP/envelope codes; response/error envelope, pagination, middleware chain (recovery, request-id, access log, CORS, rate-limit, RequireAuth).
- `events` — transactional outbox publisher + registry + polling relay (`FOR UPDATE SKIP LOCKED`, retries, dead-letter).
- `audit` — append-only audit writer + outbox consumer (FR-AUD-01/02).
- `storage` — `Provider` interface + Cloudinary adapter + no-op fallback (ADR-001).
- `cache`, `ratelimit` — in-process implementations behind interfaces (Redis seam).

**Identity module** (`backend/internal/identity/`)
- SQLC-generated repository; service implementing `identity.Service` (Login, VerifyMFA, Refresh-with-rotation + reuse-detection, Logout, Me).
- Account lockout after N failures; refresh-token rotation; tenant resolved by workspace slug.
- Thin HTTP handlers: `/auth/login`, `/auth/mfa`, `/auth/refresh`, `/auth/logout` (public, cookie-based) and `/auth/me` (protected); httpOnly refresh cookie.
- `ports.go` is the extraction seam.

**Database** (`backend/db/migrations/`)
- `00001` — tenancy, subscription, identity/access, audit, outbox (Ethiopia defaults: ETB / Africa/Addis_Ababa); **RLS ENABLE + FORCE** + `tenant_isolation` policies on every tenant-owned table.
- `00002` — `clinic_app` least-privilege role grants + default privileges.
- goose, embedded in the binary, reversible.

**Entrypoints** — `cmd/api` (server + `/healthz` `/readyz` `/metrics`, graceful shutdown, connect-with-retry), `cmd/worker` (outbox relay + audit consumer), `cmd/migrate` (embedded goose), `cmd/seed` (demo tenant + owner + 15 system roles + permissions + Business flags).

**Frontend** (`frontend/`) — Vite + TS + Tailwind + ShadCN-style primitives; API client with single-flight refresh interceptor; in-memory access token + silent boot refresh; Login → MFA → protected Dashboard (renders `/auth/me`); `ProtectedRoute` auth guard; feature-sliced layout.

**Infra & CI** — multi-stage distroless backend image; Caddy edge (SPA + `/api` proxy, env-driven TLS); Compose base + dev/staging/prod; Postgres init script for `clinic_app`; GitHub Actions (build, vet, unit, **RLS integration with a Postgres service**, stale-SQLC check, import-boundary lint, frontend build, gitleaks).

## Verification
| Check | Result |
|---|---|
| `go build ./...`, `go vet ./...` | ✅ pass |
| `go test ./... -short` (auth, id, db) | ✅ pass |
| `go run ./tools/importlint` | ✅ boundaries OK |
| `sqlc generate` (no diff) | ✅ up to date |
| Frontend `tsc --noEmit` + `vite build` | ✅ pass (98 KB gz) |
| Compose + CI YAML parse | ✅ valid |
| **RLS cross-tenant isolation** | ⏳ test written; runs in CI / `make test-integration` (needs Postgres — not available in this sandbox) |
| `docker compose up` end-to-end | ⏳ needs Docker daemon (unavailable in this sandbox) — verified by config/parse |

## Remaining work
None within Phase 0 scope. Deferred by design: platform/super-admin roles, SSO/OIDC, subdomain→tenant slug cross-check enforcement (resolution seam in place).

## Technical debt / known limitations
- `/metrics` returns a placeholder gauge (real Prometheus metrics deferred — ADR-001 §6).
- Rate limiter and cache are single-instance (correct for one API replica; Redis seam ready).
- `clinic_app` password is set at first DB init; rotating it later requires a manual `ALTER ROLE`.
- Audit currently covers auth events + all outbox events; sensitive-read auditing arrives with the data modules.

## Risks (tracked in [OPEN_QUESTIONS.md](../OPEN_QUESTIONS.md))
- Single-VPS SPOF vs NFR-08/11 — backup/WAL strategy to confirm (Q8).
- Cloudinary PHI suitability (Q2 answered: proceed behind interface; validate terms before Phase 1 attachments).
- RLS+pooler GUC interaction — mitigated via `SET LOCAL`/`set_config(...,true)` inside every tx; covered by the integration test.

## Recommended next phase
**Phase 1 — Core Clinic MVP:** complete `identity` (invitations, user lifecycle, RBAC enforcement middleware), `org` (clinics/branches/departments/resources), and `patient` (registration wizard, duplicate detection via `pg_trgm`, search <400 ms, attachments via Cloudinary presign, allergies/conditions, guardian links). Target: self-onboard a tenant to first patient registered in < 15 min.
