# Clinic Management SaaS

A cloud-native, multi-tenant **Clinic Management SaaS** — a modular monolith (Go + React) built phase by phase. See **[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md)** for the full picture, **[docs/roadmap.md](docs/roadmap.md)** for the plan, and **[docs/adr/](docs/adr/)** for key decisions.

**Status:** ✅ Phase 0 — Foundation (auth + multi-tenant + RBAC kernel, Docker, CI). Next: Phase 1 — Core Clinic MVP (patients).

## Architecture (MVP)

- **Backend:** Go + Gin + SQLC + PostgreSQL. Modular monolith (`api` + `worker` binaries), clean layering (HTTP → service → domain → repo), transactional outbox events.
- **Frontend:** React + TypeScript + Vite + TanStack Query + Tailwind + ShadCN + React Hook Form + Zod.
- **Tenant isolation:** `tenant_id` on every row, enforced by repository predicates **and** Postgres RLS. The app connects as a non-superuser `clinic_app` role so RLS is actually enforced ([ADR-002](docs/adr/ADR-002-multitenancy.md)).
- **Edge:** Caddy serves the SPA and reverse-proxies `/api`. One VPS, Docker Compose, three environments.
- **Swappable seams:** `StorageProvider` (Cloudinary), `SearchPort` (Postgres FTS/trgm), `EventBus` (Postgres outbox), `Cache`/`RateLimiter` (in-process) — each upgradable later without touching domain code ([ADR-001](docs/adr/ADR-001-infra-reconciliation.md)).

## Layout

```
backend/     Go modular monolith (cmd/{api,worker,migrate,seed}, internal/{kernel,identity}, db/migrations)
frontend/    React SPA (feature-sliced: app/, features/, components/, lib/)
infra/       Caddyfile, web image, Postgres init scripts
compose*.yml Base + dev/staging/prod overlays
docs/        Blueprints, digests, roadmap, ADRs, open questions
```

## Quick start (Docker)

```bash
cp .env.example .env
# Set strong secrets in .env:
#   JWT_SECRET       (openssl rand -base64 48)
#   MFA_ENC_KEY      (openssl rand -base64 32)   # must decode to 32 bytes
#   APP_DB_PASSWORD  (openssl rand -hex 24)

docker compose -f compose.yml -f compose.dev.yml up --build
# Postgres init → migrations (as superuser) → api+worker (as clinic_app) → Caddy

# Seed a demo tenant + owner (one-off):
docker compose -f compose.yml -f compose.dev.yml run --rm api /app/seed
```

Open **http://localhost:8088** and sign in:

| Field | Value |
|---|---|
| Workspace | `demo` |
| Email | `owner@demo.clinic` |
| Password | `ChangeMe123!` |

The API is also exposed directly on `http://localhost:8080` in dev.

### Pulling new code / switching phases

The migrations and the built SPA are baked into the images, so **always rebuild** after pulling changes — otherwise you run the old frontend and miss new migrations:

```bash
# Rebuilds api/worker/migrate/web; the `migrate` service then applies any new
# migrations to the existing volume (no data loss).
docker compose -f compose.yml -f compose.dev.yml up --build

# Idempotent re-seed: grants the owner any newly-added permissions.
docker compose -f compose.yml -f compose.dev.yml run --rm api /app/seed
```

Re-seeding matters when a phase adds permissions (e.g. Phase 3a's `payment.collect`,
`triage.manage`) — without it those screens return **403** even for the owner.

### Troubleshooting

- **`password authentication failed for user "clinic_app"` (28P01):** the `pgdata`
  volume was created with a different `APP_DB_PASSWORD` than your current `.env`.
  Either set `APP_DB_PASSWORD` back to the value the volume was created with, or
  start fresh (this **wipes the database**, then re-seed):

  ```bash
  docker compose -f compose.yml -f compose.dev.yml down -v
  docker compose -f compose.yml -f compose.dev.yml up --build
  docker compose -f compose.yml -f compose.dev.yml run --rm api /app/seed
  ```

- **First `up --build` is slow** (Go + Vite builds). Subsequent runs are cached.

## Local dev (no Docker)

```bash
# Postgres running locally with the clinic_app role granted (see infra/postgres/initdb).
cd backend
cp ../.env.example ../.env        # export these into your shell
make migrate-up                   # apply migrations
make seed                         # demo tenant + owner
make run-api                      # terminal 1
make run-worker                   # terminal 2

cd ../frontend
npm install
npm run dev                       # http://localhost:5173 (proxies /api → :8080)
```

## Testing

```bash
cd backend
make test-unit                    # fast, no DB
TEST_DATABASE_URL=postgres://clinic:clinic@localhost:5432/clinic_test?sslmode=disable \
  make test-integration           # RLS cross-tenant isolation (NFR-13)
make vet
go run ./tools/importlint         # module-boundary enforcement

cd ../frontend && npm run build   # typecheck + production build
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs all of the above plus a stale-SQLC check and a gitleaks secret scan on every push/PR.

## Configuration

All config is environment-driven (12-factor) and validated at startup. See **[.env.example](.env.example)** for the full list. No secrets in code (NFR-14).

## Phase 0 acceptance

A seeded user signs in (with MFA when enabled), receives a short-lived access token + rotating refresh cookie, and `GET /api/v1/auth/me` returns their roles, permissions, and feature flags — scoped to their tenant, with cross-tenant access blocked by RLS (verified by `make test-integration`).
