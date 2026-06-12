# Clinic Management SaaS — Project Context

> One-page orientation. Read this first, then the [roadmap](./roadmap.md) and [ADRs](./adr/).

## What this is
A cloud-native, **multi-tenant Clinic Management SaaS** for small → multi-branch clinics. It digitises the full outpatient journey: registration → appointments → queue → consultation/EMR → lab → pharmacy → billing → insurance → analytics. One codebase serves a solo doctor and a 40-branch group; the difference is **subscription tier + feature flags + configuration**, never a code fork.

- **31 modules**, **17 roles**, **4 subscription tiers** (Starter / Professional / Business / Enterprise), **7 feature flags**.
- **66-table PostgreSQL schema** across 13 domains (see [Part 2 digest](./digests/P2-ARCH-DB-MODULES.md)).
- Source of truth: the blueprints in [`docs/blueprints/`](./blueprints/) (extracted from `Documentations/*.docx`).

## Architecture (MVP)
- **Modular monolith**, microservice-ready. One Go `api` binary + one `worker` binary. Strict module boundaries enforced in CI; cross-module calls only through `ports.go` interfaces or `event_outbox` events.
- **Clean layering:** HTTP (Gin) → service (use-cases, tx, flags, events) → domain (pure) → repository (SQLC, tenant-predicated).
- **Multi-tenant by construction:** `tenant_id` on every tenant-owned row, enforced by repository predicates **and** Postgres RLS (`app.tenant_id` GUC). See [ADR-002](./adr/ADR-002-multitenancy.md).
- **Event-driven internally** via the **transactional outbox** (`event_outbox` table) — in-process dispatcher + worker relay now; RabbitMQ later behind the same `EventBus` interface.
- **Future-proof seams** in `kernel`: `EventBus`, `StorageProvider`, `Cache`, `RateLimiter`, `SearchPort` — all with simple MVP implementations.

## Stack
| Area | MVP choice |
|---|---|
| Frontend | React, TypeScript, Vite, React Router, TanStack Query, TailwindCSS, ShadCN UI, React Hook Form, Zod |
| Backend | Go (Gin), SQLC, PostgreSQL |
| Migrations | goose (versioned, reversible) |
| Object storage | Cloudinary, behind a `StorageProvider` interface (S3/MinIO/Spaces/B2 later) |
| Search | PostgreSQL `pg_trgm` + FTS, behind a `SearchPort` interface (OpenSearch later) |
| Async | Postgres outbox + in-process relay (RabbitMQ later) |
| Cache / sessions | In-memory + Postgres-backed sessions (Redis later, justified at Phase 2 if multi-replica) |
| Deploy | Docker Compose (dev/staging/prod) on a single Oracle Cloud VPS, Caddy TLS (K8s later) |
| Observability | Structured JSON logs + `/healthz` `/readyz` `/metrics` (Prometheus/Grafana/Loki/OTel later) |

The MVP stack **deliberately simplifies** the blueprint's heavy stack (Redis/RabbitMQ/OpenSearch/S3/K8s) per the authoritative infra override — every simplification keeps a documented upgrade seam. Full rationale: [ADR-001](./adr/ADR-001-infra-reconciliation.md).

## Delivery model — strict phase-driven, vertical slices
Each phase is a complete vertical slice (FE + BE + DB + permissions + tests) that is **deployable and demonstrably valuable**. Never skip phases; never leave one half-done.

| Phase | Theme | Result |
|---|---|---|
| **0** | Foundation | Devs/seed user can log in (MFA), get rotating tokens, reach a tenant-scoped protected area; cross-tenant access provably impossible |
| **1** | Core Clinic MVP | Onboarding + users/roles + clinic/branch/dept + patient registration/profile/search (first usable product) |
| 2 | Appointments & Queue | Scheduling + live queue board |
| 3 | Consultation & EMR | SOAP notes, vitals, diagnoses, prescriptions, dynamic forms |
| 4 | Laboratory | Test catalog, orders, samples, results lifecycle |
| 5 | Pharmacy | Drug catalog, batch/expiry, dispensing, purchasing |
| 6 | Inventory | Stock, transfers, purchasing, counts |
| 7 | Billing | Charges → invoices → payments/refunds, insurance (flagged) |
| 8 | Reporting & Analytics | Role dashboards, exports, consolidated multi-branch |
| 9 | Multi-Branch | Branch scoping hardening, shared catalogues + overrides |
| 10 | Advanced SaaS | Subscriptions, usage limits, tenant billing, feature-flag maturity, deferred-infra promotions |

Full detail (scope, deliverables, deps, risks, success criteria) per phase: [roadmap.md](./roadmap.md).

## Current status
- **Phase 0 — Foundation:** planning complete; implementation pending. See [roadmap.md](./roadmap.md#phase-0--foundation).
- Open decisions that affect later phases are tracked in [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md).

## Output format for implementation work
Per the delivery framework, each implementation request reports: Current Phase · Phase Goal · Feature Scope · Architecture Impact · Files To Create · Files To Modify · Database Changes · API Changes · Frontend Changes · Testing Plan · Implementation. Each phase ends with a Completion Report (Completed / Remaining / Tech Debt / Risks / Next Phase).
