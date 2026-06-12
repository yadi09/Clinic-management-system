# Clinic Management SaaS — Part 2 Digest: System, Frontend, Backend & Database Architecture

Document: `Clinic_SaaS_Blueprint_Part-2.docx` — "Implementation-Ready Blueprint, Part 2 of 2." Covers Sections 5–8 (continues from Part 1). Status: implementation-ready draft v3.

**Declared stack (header):** React / TypeScript / Vite · Go / Gin / SQLC · PostgreSQL · Redis · RabbitMQ · OpenSearch · S3 · Docker / Kubernetes. Architecture = modular monolith, microservice-ready, event-driven, multi-tenant. Each architecture diagram and ERD is rendered on its own full landscape page.

---

## 5. System Architecture

A modular monolith with microservice-ready seams: one deployable today, cleanly extractable tomorrow. API-first, event-driven, multi-tenant from the first commit.

### 5.1 Architectural Principles
- **Modular monolith first** — one Go binary plus a worker binary; strict internal boundaries preserve later extraction.
- **Microservice-ready seams** — modules never reach into each other's tables; communicate via service interfaces + domain events.
- **API-first** — every capability exposed through REST API; web client is one consumer among future mobile apps + integrators.
- **Event-driven** — state changes publish domain events; side effects (billing, notifications, search indexing, audit) react asynchronously.
- **Multi-tenant by construction** — tenant context resolved once at the edge, enforced in data layer; cross-tenant access impossible by contract.
- **Twelve-factor & cloud-native** — stateless services, config from environment, secrets from a manager, horizontal scaling, container deployment.

### 5.2 High-Level Architecture (Figure 5.1)
Requests enter via TLS-terminating ingress → API gateway (routing, rate limiting, authentication) → modular-monolith API. Modules share a kernel (tenancy, auth, persistence, events) but own domains. Writes publish events to an internal bus bridged to RabbitMQ; workers handle notifications, search indexing, report generation.

**Data-tier roles:** PostgreSQL = system of record; Redis = caching + sessions; OpenSearch = search + analytics; S3-compatible storage = files.

**Layer responsibilities (Table 5.1):**

| Layer | Responsibility | Key Technology |
|---|---|---|
| Client | Render UI, capture input, hold session | React/TS SPA, Patient Portal, API integrators |
| Edge | TLS, routing, rate limiting, authentication | Ingress, API gateway |
| Application | Domain logic across modules; publish events | Go/Gin modular monolith |
| Async | Decoupled side effects + heavy jobs | RabbitMQ + worker pods |
| Data | Durable state, cache, search, files | PostgreSQL, Redis, OpenSearch, S3 |
| External | Third-party capabilities | Email/SMS, payment gateway, lab devices |

### 5.3 Module Boundaries & Dependency Rules (enforced in code review + package-import linting)
- **Own your data** — a module reads/writes only its own tables; never issues SQL against another module's tables.
- **Talk through interfaces** — synchronous cross-module needs go through a published Go interface, not a direct struct/DB dependency.
- **Prefer events for side effects** — anything eventually consistent (charges, notifications, indexing, audit) is driven by a domain event, not inline call.
- **Depend only inward** — modules depend on the shared kernel (tenancy, auth, persistence, events, errors); kernel never depends on a module.
- **No shared mutable state** — modules share nothing but the kernel + event contracts.

### 5.4 Top-Level Module Structure (Go layout)
```
clinicsaas/
├─ cmd/
│   ├─ api/            # API server entrypoint
│   └─ worker/         # async worker entrypoint
├─ internal/
│   ├─ kernel/         # shared: tenancy, auth, db, events, errors, config
│   ├─ identity/       # auth, users, roles, tenants (bounded module)
│   ├─ org/            # clinics, branches, departments
│   ├─ patient/        # patients, search, attachments
│   ├─ scheduling/     # appointments, queue
│   ├─ clinical/       # consultation, EMR, notes, vitals, dx, rx, forms
│   ├─ laboratory/     # LIS
│   ├─ pharmacy/       # drugs, batches, dispensing
│   ├─ inventory/      # stock, transfers, purchasing
│   ├─ finance/        # billing, invoicing, payments, insurance
│   └─ platform/       # notifications, reporting, analytics, audit, settings
```
**11 bounded modules** (kernel + identity, org, patient, scheduling, clinical, laboratory, pharmacy, inventory, finance, platform).

### 5.5 Event-Driven Design
Events first emitted to an in-process dispatcher, persisted via **transactional outbox pattern**: event row written in same DB transaction as state change, then a **relay publishes to RabbitMQ** marking rows dispatched. Guarantees at-least-once delivery without dual-write inconsistency. **Consumers are idempotent (keyed by event id).**

**Core event catalog (Table 5.2):**

| Event | Published By | Consumed By (effect) |
|---|---|---|
| PatientRegistered | Patient | Search Indexer (index), Audit |
| AppointmentBooked | Scheduling | Notifications (reminder), Audit |
| PatientCheckedIn | Scheduling/Queue | Queue (enqueue), Analytics |
| EncounterClosed | Clinical | Finance (consultation charge), Notifications, Audit |
| LabResultApproved | Laboratory | Clinical (attach to encounter), Notifications (patient), Finance (lab charge) |
| MedicationDispensed | Pharmacy | Finance (pharmacy charge), Inventory (decrement), Audit |
| InvoiceIssued | Finance | Notifications (receipt), Analytics |
| PaymentCaptured | Finance | Analytics (revenue), Audit |

### 5.6 Service Interaction Model
Synchronous calls reserved for request/response work the user waits on (read encounter, validate booking). Everything deferrable is asynchronous.
**"Close encounter" sequence (Figure 5.3):** Doctor signs note (sync write) → Clinical commits + writes outbox `EncounterClosed` → Relay → RabbitMQ → Finance adds consultation charge → Notifications queues patient summary → Audit records the action.

### 5.7 Multi-Tenancy Strategy
**Model: shared database, shared schema** with mandatory `tenant_id` on every tenant-owned table. Two enforcement levels:
- **Repository-enforced predicates** — every query generated to include tenant (and branch where relevant) predicate; repository layer injects tenant context so a query physically cannot omit it.
- **Optional PostgreSQL Row-Level Security (RLS)** — defence in depth; policies keyed on a session tenant GUC reject cross-tenant rows.

**Scaling path:** at Phase B/C, large tenants moved to dedicated schemas or shards with same code (uniform tenant key). Hot tables partitioned by tenant and/or time (Section 8.8). A few very large tenants MAY be isolated onto dedicated DB clusters without code change.

**Multi-tenancy decisions (Table 5.3):**

| Concern | Approach |
|---|---|
| Isolation | tenant_id on every row + repository predicates (+ optional RLS) |
| Noisy neighbour | Per-tenant rate limits at gateway; connection pooling; query budgets |
| Large tenants | Schema-per-tenant or dedicated cluster migration without code change |
| Onboarding | Row inserts only — no per-tenant schema creation at base tier |
| Data residency (future) | Tenant → region routing at the edge; region-pinned clusters |

### 5.8 Deployment Topology (Figure 5.4)
Stateless, horizontally scalable deployments on **Kubernetes** behind an ingress controller. **API pods scale via Horizontal Pod Autoscaler on CPU and request latency; worker pods scale on queue depth.** Stateful services (PostgreSQL, Redis, RabbitMQ, OpenSearch) managed or run as operators; object storage is external.

### 5.9 Cross-Cutting Concerns (Table 5.4)

| Concern | Where Handled | Notes |
|---|---|---|
| AuthN/AuthZ | Gateway + middleware | JWT verify at edge; role+scope+flag checks in service layer |
| Tenant resolution | Middleware (kernel) | Resolved from token claims into request context |
| Logging | Middleware + **Loki** | Structured JSON logs with tenant/request correlation IDs |
| Metrics | **Prometheus** | RED metrics per endpoint; queue depth; DB pool stats |
| Tracing | **OpenTelemetry** | Trace IDs propagate client → API → worker |
| Config | Env + secrets manager | No secrets in code; per-environment overrides |
| Audit | Event consumer | Immutable append-only audit store |

### 5.10 Microservice Extraction Path
Strangler approach: stand up module as its own deployable, route its API namespace at the gateway, switch event publish/consume to the shared broker (already the transport).

**Recommended extraction sequence (Table 5.5):**

| Order | Module | Why It Extracts Cleanly |
|---|---|---|
| 1 | Notifications | Already event-driven, stateless, no inbound coupling |
| 2 | Laboratory (LIS) | Self-contained domain; device integration benefits from isolation |
| 3 | Pharmacy + Inventory | Stock-heavy, distinct scaling profile |
| 4 | Reporting/Analytics | Read-heavy; can run off replicas/OpenSearch independently |
| 5 | Finance | Sensitive and high-value; isolate once volume warrants |

---

## 6. Frontend Architecture

Feature-sliced React + TypeScript SPA. TanStack Query owns server state; React Hook Form + Zod own forms/validation; every route gated by role, scope, and feature flag.

### 6.1 Principles
- Feature-based structure (by domain feature, not technical type).
- Server state (TanStack Query) vs UI state (local/light store) never conflated.
- Typed end-to-end: API responses validated with **Zod at the boundary**, producing trusted TS types.
- Composition over configuration: **ShadCN UI** primitives + **Tailwind** design tokens.
- Guard at the route: auth, role/scope, feature-flag checks at route boundary.

### 6.2 Folder Structure (Feature-Sliced)
```
src/
├─ app/
│   ├─ router.tsx            # route tree + lazy imports
│   ├─ providers.tsx         # QueryClient, Auth, Theme, Toaster
│   └─ layouts/              # AppShell, AuthLayout, BranchLayout
├─ features/
│   ├─ auth/        {api.ts, hooks.ts (useLogin, useSession), components/, pages/ (LoginPage, MfaPage)}
│   ├─ patients/    {api.ts, schemas.ts (Zod), hooks.ts (usePatients, useCreatePatient), components/ (PatientCard, DuplicateWarning), pages/ (PatientListPage, PatientFormPage)}
│   ├─ appointments/  scheduling/  queue/
│   ├─ consultation/  emr/  prescriptions/  forms/
│   ├─ laboratory/  pharmacy/  inventory/
│   ├─ billing/  payments/  insurance/
│   └─ admin/        # tenant, branches, users, roles, settings
├─ components/
│   ├─ ui/           # ShadCN primitives (button, dialog, table...)
│   └─ common/       # DataTable, PageHeader, EmptyState, ErrorState
├─ lib/
│   ├─ api-client.ts # fetch wrapper, interceptors, error envelope
│   ├─ query.ts      # QueryClient config, query keys
│   ├─ auth.ts       # token store, refresh logic
│   ├─ rbac.ts       # can(role, action), scope helpers
│   ├─ flags.ts      # useFeatureFlag()
│   └─ form-renderer/ # dynamic JSON-schema form renderer
├─ hooks/            # useDebounce, useScope
├─ types/  styles/ (tailwind.css, tokens)  main.tsx
```

### 6.3 Component Architecture (Table 6.1)

| Tier | Examples | Rules |
|---|---|---|
| UI primitives | Button, Input, Dialog, Select (ShadCN) | Stateless, styled, no domain knowledge |
| Common components | DataTable, PageHeader, EmptyState, ErrorState, FormField | Reusable; no feature imports |
| Feature components | PatientCard, QueueBoard, EncounterPanel | Own a feature slice; use hooks for data |
| Pages | PatientListPage, ConsultationPage | Compose components; one per route; handle layout |
| Layouts | AppShell, BranchLayout | Navigation, scope switcher, outlet for pages |

### 6.4 State Management (Table 6.2)

| State Kind | Owner | Example |
|---|---|---|
| Server/remote | TanStack Query | Patient list, encounter, lab results |
| Form | React Hook Form | Registration form, SOAP note, dynamic forms |
| Global UI | Light store (**Zustand**) / Context | Active branch scope, theme, toasts |
| Local component | useState/useReducer | Dialog open, tab selection |
| URL | React Router params/search | Filters, pagination, selected ids |

**Query conventions:** structured/centralised keys (e.g., `['patients', { branchId, filters }]`); mutations invalidate minimal key set; optimistic updates for fast interactions (queue state, vitals) with rollback on error.

### 6.5 API Layer Design (single typed client wrapping fetch)
- **Auth interceptor** — attaches access token; on 401, attempts a single refresh, retries once, then redirects to login.
- **Tenant/scope headers** — active branch scope travels with each request where relevant.
- **Error envelope normalisation** — server errors parsed into typed `AppError { code, message, fields }`.
- **Zod parsing** — responses validated against Zod schemas; parse failure surfaces as typed error.
- **Pagination/filter helpers** — standard serialisation of pagination, filtering, sorting, search.

### 6.6 Form Strategy
Static forms = React Hook Form + Zod resolver. Dynamic form renderer interprets the form builder's **versioned JSON schema (Section 4.3.8 / FR-FRM)** at runtime: maps each field type to a controlled component, applies conditional visibility rules, builds a Zod schema on the fly from field validation rules. **Submitted data stored against the captured schema version** so historical records render exactly as entered.

**Dynamic form field mapping (Table 6.3):**

| Field Type | Component | Validation Source |
|---|---|---|
| text / textarea | Input / Textarea | min/max length, pattern (regex) |
| number | Numeric Input | min/max, integer/decimal |
| date / time | DatePicker / TimePicker | range, required |
| checkbox / radio | Checkbox / RadioGroup | required, allowed values |
| dropdown / multi-select | Select / MultiSelect | enum, min/max selections |
| file upload | FileDropzone (→ **S3 presigned**) | type, size limits |
| signature | SignaturePad (→ image) | required |

Field types enumerated: text, number, date, checkbox, radio, dropdown, multi-select, file, signature.

### 6.7 Routing & Route Protection
React Router nested route tree, lazy-loaded pages. `ProtectedRoute` composes three guards (short-circuit to fallback):
- **Authentication guard** — no valid session → redirect to login (preserving intended destination).
- **Authorisation guard** — role/scope check via `rbac.ts`; insufficient → 403 view.
- **Feature-flag guard** — module disabled for tenant → hidden in nav + blocked with upgrade prompt.

Example nesting: `ProtectedRoute` → `AppShell` → `/patients` (PatientListPage); `RequireFlag flag="laboratory"` → `RequireRole anyOf={['lab_tech','lab_manager']}` → `/lab/worklist` (LabWorklistPage).

### 6.8 Authentication Flow
Access tokens short-lived, held in memory; refresh token in **httpOnly cookie** (or secure store), **rotated on use**.
**Token lifecycle (Figure 6.2):** Login → access + refresh issued → access in memory, refresh in httpOnly cookie → 401 → interceptor refreshes once → refresh rotates, retry request → refresh fails → clear + redirect to login.

### 6.9 Error Handling (Table 6.4)

| Scope | Mechanism | UX |
|---|---|---|
| Render errors | React error boundaries per layout/route | Friendly fallback + retry, error reported |
| Query errors | TanStack Query error state | Inline ErrorState with retry |
| Mutation errors | onError + typed AppError | Toast + field-level messages from envelope |
| Validation errors | Zod + RHF field errors | Inline messages next to fields |
| Auth errors | Interceptor (401/refresh) | Silent refresh or redirect |
| Network/offline | Query retry + offline indicator | Banner; reads from cache where possible |

---

## 7. Backend Architecture

Go + Gin + SQLC; clean, layered, domain-oriented modules. Thin handlers, rich services, compile-time-checked SQL, side effects via events.

### 7.1 Principles
- Clean layered architecture; dependencies point inward: HTTP → service → domain → repository.
- Domain-driven bounded modules own their domain model, services, repositories, handlers.
- Thin handlers, rich services (all business rules + transactions in service layer).
- Compile-time-safe SQL via SQLC; no hand-rolled string SQL, no ORM.
- Explicit transactions and events; services write to the outbox in same transaction as state change.

### 7.2 Layered Architecture (Table 7.1)

| Layer | Responsibility | Depends On |
|---|---|---|
| HTTP (Gin) | Routing, DTO binding, request validation, response shaping | Service interfaces |
| Middleware | Auth, tenant/scope resolution, rate limit, logging, recovery, audit context | Kernel |
| Service (use-case) | Business rules, transactions, feature-flag checks, event publication | Domain, repositories |
| Domain | Entities, value objects, invariants, domain events | Nothing (pure) |
| Repository (SQLC) | Typed queries with tenant predicates; map rows ↔ domain | Database driver |
| Event | Outbox write + publish to RabbitMQ | Kernel, broker |
| Background jobs | Consume events, run schedules; idempotent handlers | Services |

### 7.3 Project Structure (per-module standard layout)
```
clinicsaas/
├─ cmd/
│   ├─ api/main.go       # wires kernel + modules, starts Gin
│   └─ worker/main.go    # starts RabbitMQ consumers + schedulers
├─ internal/
│   ├─ kernel/
│   │   ├─ config/        # env loading, typed config
│   │   ├─ auth/          # JWT, password, MFA, token store
│   │   ├─ tenancy/       # tenant/scope context + resolver
│   │   ├─ db/            # pgx pool, tx manager, RLS GUC set
│   │   ├─ events/        # bus, outbox, publisher, consumer base
│   │   ├─ httpx/         # error envelope, pagination, middleware
│   │   └─ audit/         # audit event helper
│   ├─ patient/
│   │   ├─ domain/        # Patient entity, value objects, events
│   │   ├─ service/       # PatientService (use-cases), rules
│   │   ├─ repo/queries/  # *.sql files (SQLC source)
│   │   ├─ repo/gen/      # SQLC-generated Go (do not edit)
│   │   ├─ http/          # handlers, DTOs, routes
│   │   └─ ports.go       # interfaces this module exposes/consumes
│   ├─ identity/ org/ scheduling/ clinical/ laboratory/ pharmacy/
│   ├─ inventory/ finance/ platform/   # same internal layout
├─ db/migrations/         # versioned, reversible (goose/atlas)
├─ db/sqlc.yaml
├─ api/openapi.yaml       # source of REST contract
├─ deploy/                # Dockerfiles, k8s manifests, charts
└─ go.mod
```

### 7.4 Repository Layer (SQLC)
Every tenant-owned query takes `tenant_id` (and branch where relevant) as a parameter supplied by the tenancy context so callers cannot forget it. Multi-statement work runs in a transaction via the kernel tx manager. Example queries:
```sql
-- name: GetPatientByMRN :one
SELECT * FROM patients WHERE tenant_id = $1 AND mrn = $2 AND deleted_at IS NULL;

-- name: SearchPatients :many
SELECT * FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL
  AND (mrn ILIKE $2 OR phone ILIKE $2 OR (first_name || ' ' || last_name) ILIKE $2)
ORDER BY last_name, first_name LIMIT $3 OFFSET $4;
```
- Generated code never edited; query changes made in SQL and regenerated.
- Repositories map SQLC rows ↔ domain types; no domain logic in SQL.
- Tx manager exposes `WithTx(ctx, fn)` to compose repository calls + outbox write atomically.

### 7.5 Service Layer
A use-case typically: (1) authorises against role/scope/flag, (2) loads domain entities, (3) enforces invariants, (4) persists within a transaction, (5) writes domain events to the outbox, (6) returns a result DTO.
**Close-encounter responsibilities:** Authorise (doctor + scope) → load encounter + validate state → apply note signing rules → `BEGIN tx`: persist note + mark closed + outbox `EncounterClosed` → `COMMIT` → return `EncounterDTO`.
**Feature flags:** services consult the flag resolver early; a disabled module short-circuits with a recoverable error before any work — **matches FR-TEN-03**.

### 7.6 HTTP Layer
- Routes registered per module under versioned prefix (e.g., `/api/v1/patients`).
- Handlers bind/validate request DTOs (struct tags + explicit checks), call service, map results/errors to response envelope. No business logic.

**Standard envelopes:**
```json
// success
{ "data": { ... }, "meta": { "page": 1, "pageSize": 20, "total": 134 } }
// error
{ "error": { "code": "PATIENT_DUPLICATE", "message": "A matching patient already exists",
             "fields": { "nationalId": "already in use" } } }
```

### 7.7 Middleware Layer (Table 7.2, outermost first)

| Order | Middleware | Responsibility |
|---|---|---|
| 1 | Recovery | Catch panics → 500 envelope; never crash process |
| 2 | Request ID / Tracing | Assign correlation + trace IDs; propagate |
| 3 | Structured Logging | Log method, path, status, latency, tenant, request id |
| 4 | Rate Limiting | Per-tenant and per-IP limits (**Redis token bucket**) |
| 5 | Authentication | Verify JWT; load principal into context |
| 6 | Tenant/Scope Resolution | Derive tenant + allowed branches/departments into context |
| 7 | Audit Context | Stamp actor/tenant for downstream audit events |

### 7.8 Event Layer (Table 7.3 — messaging topology & reliability)
Domain events written to outbox table inside same transaction as state change. A relay polls the outbox, publishes to RabbitMQ, marks rows dispatched.

| Element | Choice |
|---|---|
| Exchange | **Topic exchange per environment** |
| Routing key | `<module>.<aggregate>.<event>` (e.g., `laboratory.result.approved`, `clinical.encounter.closed`) |
| Delivery | At-least-once; consumers idempotent (dedupe on `event_id`) |
| Reliability | Transactional outbox + relay; **publisher confirms** |
| Failure handling | Retry with backoff; **dead-letter queue after N attempts** |
| Ordering | Per-aggregate ordering via event sequence; no global order assumed |

### 7.9 Background Job Layer
- **Event consumers** — workers subscribe to routing keys, invoke service use-case (e.g., add charge on `EncounterClosed`); idempotent, redeliver-safe.
- **Schedulers** — cron-style jobs for appointment reminders, near-expiry pharmacy alerts, stock reorder checks, report generation.
- **Isolation** — workers run as separate deployment (`cmd/worker`) so async load never degrades request latency.
- **Observability** — each job emits metrics (processed, failed, duration) + logs with originating event id.

### 7.10 Configuration & Secrets
- Config loaded from env vars into a typed config struct validated at startup; process fails fast on missing/invalid config.
- Secrets (DB credentials, JWT signing keys, provider API keys) from secrets manager / **Kubernetes secrets**, never source/images.
- Per-environment overrides (dev/staging/prod) layered; no environment-specific code branches.

### 7.11 Error Handling → HTTP Code Map (Table 7.4)

| Error Class | Origin | HTTP | Envelope code |
|---|---|---|---|
| Validation | Handler/DTO binding | 400 | `VALIDATION_FAILED` |
| Authentication | Auth middleware | 401 | `UNAUTHENTICATED` |
| Authorisation | Service guard | 403 | `FORBIDDEN_SCOPE` |
| Not found | Repository/service | 404 | `PATIENT_NOT_FOUND` |
| Conflict | Service invariant | 409 | `PATIENT_DUPLICATE` |
| Feature disabled | Flag resolver | 402/409 | `MODULE_DISABLED` |
| Rate limited | Rate-limit middleware | 429 | `RATE_LIMITED` |
| Internal | Unexpected | 500 | `INTERNAL_ERROR` |

---

## 8. Database Design

Single PostgreSQL schema, multi-tenant by `tenant_id`, normalised (3NF), soft-deleted, fully audited.

### 8.1 Design Principles
- PostgreSQL system of record; 3NF by default; JSONB only for genuinely dynamic data (form submissions, settings, audit payloads).
- Multi-tenant shared schema; every tenant-owned table has non-null `tenant_id`; all access tenant-filtered.
- Surrogate keys: **UUID v7** PKs (time-ordered, index-friendly), named `id`.
- Soft delete: clinical/financial rows use `deleted_at`; physical deletes avoided.
- Auditability: mutations emit audit events; audit store append-only.
- **Money as `NUMERIC(12,2)`; timestamps as `TIMESTAMPTZ` in UTC; enums as TEXT with CHECK constraints or reference tables.**

### 8.2 Conventions & Standard Columns (Table 8.1 — on every tenant-owned table)

| Column | Type | Null | Notes |
|---|---|---|---|
| id | UUID | NO | PK, UUID v7, default generated |
| tenant_id | UUID | NO | FK → tenants(id); on every tenant-owned table; indexed |
| created_at | TIMESTAMPTZ | NO | default now() |
| updated_at | TIMESTAMPTZ | NO | default now(); maintained on update |
| created_by | UUID | YES | FK → users(id); actor who created the row |
| deleted_at | TIMESTAMPTZ | YES | soft-delete marker; NULL = active |

**Naming:** snake_case plural tables; FKs `<referent>_id`; junction tables `<a>_<b>`. All FKs indexed; all unique business keys scoped by `tenant_id`.

### 8.3 ERDs (crow's-foot notation; standard columns omitted)
- Figure 8.1 — Tenancy, Organisation & Identity/Access
- Figure 8.2 — Patient, Scheduling, Clinical/EMR & Forms
- Figure 8.3 — Laboratory, Pharmacy & Inventory
- Figure 8.4 — Finance & Insurance

### 8.4 Full Table Catalog (Table 8.2 — **66 tables across 13 domains**)

| Domain | Tables |
|---|---|
| Tenancy & Subscription | tenants, plans, subscriptions, feature_flags, billing_accounts |
| Organisation | clinics, branches, departments, resources |
| Identity & Access | users, roles, permissions, role_permissions, user_role_scopes, sessions, audit_logs |
| Patient | patients, guardian_links, patient_insurance, allergies, conditions, attachments |
| Scheduling | appointments, slots, queue_entries |
| Clinical / EMR | encounters, clinical_notes, vitals, diagnoses, procedures, referrals, follow_ups, prescriptions, prescription_items |
| Forms | form_templates, form_versions, form_submissions |
| Laboratory | lab_test_groups, lab_tests, lab_orders, lab_order_items, lab_samples, lab_results |
| Pharmacy | drugs, drug_batches, suppliers, purchase_orders, po_items, goods_receipts, dispenses, dispense_items, otc_sales |
| Inventory | inventory_items, stock_levels, stock_transfers, purchase_requests, stock_counts |
| Finance | charges, invoices, invoice_lines, payments, refunds, price_lists, discounts |
| Insurance | insurance_providers, coverage_plans, claims, claim_items, reimbursements |
| Platform | notifications, reports, settings, event_outbox |

### 8.5 Detailed Table Specifications (distinctive columns; standard columns implied)

#### 8.5.1 Tenancy & Subscription

**tenants** (top-level isolated account — a clinic or group)
- `name` TEXT NO; `slug` TEXT NO (URL-safe, UNIQUE); `status` enum NO = `created | onboarding | active | suspended | cancelled`; `plan_id` UUID NO FK→plans; `region` TEXT YES (data residency, future routing); `onboarded_at` TIMESTAMPTZ YES.
- Indexes: UNIQUE(slug); INDEX(status); INDEX(plan_id).

**plans** (platform-managed tier definitions)
- `code` TEXT NO = `starter | professional | business | enterprise` (UNIQUE); `name` NO; `branch_limit` INT YES (NULL=unlimited); `user_limit` INT YES (NULL=unlimited); `storage_gb` INT YES (NULL=custom); `audit_retention_days` INT NO; `price_monthly` NUMERIC(12,2) YES.
- Indexes: UNIQUE(code).

**subscriptions**
- `tenant_id` FK; `plan_id` FK; `status` enum NO = `trialing | active | past_due | cancelled`; `current_period_start` NO; `current_period_end` NO; `cancel_at` YES.
- Indexes: INDEX(tenant_id); INDEX(status).

**feature_flags** (per-tenant module enablement)
- `tenant_id` FK; `flag` TEXT NO = `pharmacy | laboratory | inventory | insurance | telemedicine | hr | finance_advanced`; `enabled` BOOL NO; `source` enum NO = `plan | addon | override`.
- Indexes: UNIQUE(tenant_id, flag).

**billing_accounts** (vendor-side)
- `tenant_id` FK UNIQUE; `external_customer_id` TEXT YES (gateway ref); `currency` TEXT NO (ISO 4217); `billing_email` TEXT NO.
- Indexes: UNIQUE(tenant_id).

#### 8.5.2 Organisation

**clinics** — `name` NO; `timezone` NO (IANA TZ); `locale` NO (BCP-47); `logo_s3_key` YES (object storage key). Index: INDEX(tenant_id).
**branches** — `clinic_id` FK; `name` NO; `code` NO (UNIQUE per tenant); `address` YES; `phone` YES; `opening_hours` JSONB YES (per-day); `is_active` BOOL NO default true. Indexes: UNIQUE(tenant_id, code); INDEX(clinic_id).
**departments** — `branch_id` FK; `name` NO; `specialty` YES (e.g., pediatrics, dental); `default_form_template_id` FK→form_templates YES. Index: INDEX(branch_id).
**resources** (bookable rooms/chairs/equipment) — `branch_id` FK; `department_id` FK YES; `name` NO; `type` enum NO = `room | chair | equipment`. Indexes: INDEX(branch_id); INDEX(department_id).

#### 8.5.3 Identity & Access

**users** — `email` NO (UNIQUE per tenant); `password_hash` YES (**Argon2id**; NULL until invite accepted); `full_name` NO; `status` enum NO = `invited | active | suspended | deactivated`; `mfa_enabled` BOOL NO default false; `mfa_secret` YES (encrypted TOTP); `last_login_at` YES; `failed_attempts` INT NO default 0 (lockout threshold). Indexes: UNIQUE(tenant_id, email); INDEX(status).
**roles** — `code` NO (e.g., doctor, receptionist; UNIQUE per tenant); `name` NO; `is_system` BOOL NO (system roles immutable). Index: UNIQUE(tenant_id, code).
**permissions** (global, NOT tenant-owned) — `code` NO (e.g., `patient.create`, `lab.result.approve`; UNIQUE); `description` YES. Index: UNIQUE(code).
**role_permissions** — `role_id` FK; `permission_id` FK. Index: UNIQUE(role_id, permission_id).
**user_role_scopes** — `user_id` FK; `role_id` FK; `branch_id` YES (NULL=tenant-wide); `department_id` YES (NULL=all departments in scope). Indexes: INDEX(user_id); UNIQUE(user_id, role_id, branch_id, department_id).
**sessions** — `user_id` FK; `refresh_token_hash` NO; `user_agent` YES; `ip` INET YES; `expires_at` NO; `revoked_at` YES. Indexes: INDEX(user_id); INDEX(expires_at).
**audit_logs** (append-only) — `actor_id` FK YES (NULL=system); `branch_id` YES; `action` NO (e.g., `patient.update`); `target_type` NO; `target_id` UUID YES; `payload` JSONB YES (diff/context, no secrets); `ip` INET YES; `created_at` NO (partition key). Indexes: INDEX(tenant_id, created_at); INDEX(actor_id); INDEX(target_type, target_id) — **PARTITION BY RANGE(created_at)**.

#### 8.5.4 Patient

**patients** (one MRN per tenant, shared across branches) — `mrn` NO (UNIQUE per tenant); `first_name` NO; `middle_name` YES; `last_name` NO; `gender` enum NO = `male | female | other | unknown`; `dob` DATE NO; `national_id` YES (UNIQUE per tenant when present); `passport_no` YES; `phone` YES (indexed for search); `email` YES; `address` JSONB YES; `emergency_contact` JSONB YES (name, relation, phone); `blood_group` YES. Indexes: UNIQUE(tenant_id, mrn); INDEX(tenant_id, phone); INDEX(tenant_id, national_id); **GIN trigram on name** for fuzzy search.
**guardian_links** — `patient_id` FK (dependent); `guardian_patient_id` FK→patients YES; `guardian_user_id` FK→users YES (portal user); `relationship` NO (e.g., mother, father). Index: INDEX(patient_id).
**patient_insurance** — `patient_id` FK; `provider_id` FK→insurance_providers; `coverage_plan_id` FK YES; `policy_no` NO; `valid_from` DATE YES; `valid_to` DATE YES; `is_primary` BOOL NO default true. Indexes: INDEX(patient_id); INDEX(provider_id).
**allergies** (safety-critical) — `patient_id` FK; `substance` NO; `reaction` YES; `severity` enum NO = `mild | moderate | severe`. Index: INDEX(patient_id).
**conditions** — `patient_id` FK; `icd_code` YES; `description` NO; `status` enum NO = `active | resolved | inactive`; `onset_date` DATE YES. Index: INDEX(patient_id).
**attachments** (S3-backed) — `patient_id` FK; `encounter_id` FK YES; `type` enum NO = `pdf | image | report | scan`; `s3_key` NO; `filename` NO; `mime_type` NO; `size_bytes` BIGINT NO. Indexes: INDEX(patient_id); INDEX(encounter_id).

#### 8.5.5 Scheduling

**slots** — `branch_id` FK; `provider_id` FK→users YES; `resource_id` FK→resources YES; `starts_at` NO; `ends_at` NO; `status` enum NO = `open | held | booked | blocked`. Indexes: INDEX(branch_id, starts_at); INDEX(provider_id, starts_at).
**appointments** — `branch_id` FK; `department_id` FK YES; `patient_id` FK; `provider_id` FK YES; `slot_id` FK YES; `starts_at` NO; `status` enum NO = `booked | confirmed | checked_in | completed | cancelled | no_show`; `reason` YES (chief complaint / cancel reason); `source` enum NO = `staff | portal`. Indexes: INDEX(branch_id, starts_at); INDEX(patient_id); INDEX(provider_id, starts_at); INDEX(status).
**queue_entries** — `branch_id` FK; `department_id` FK; `patient_id` FK; `appointment_id` FK YES; `state` enum NO = `waiting | called | in_consult | done | no_show`; `priority` INT NO default 0 (higher = triaged first); `enqueued_at` NO. Index: INDEX(department_id, state, priority, enqueued_at).

#### 8.5.6 Clinical / EMR

**encounters** — `patient_id` FK; `branch_id` FK; `department_id` FK YES; `provider_id` FK NO; `appointment_id` FK YES; `status` enum NO = `open | closed`; `started_at` NO; `closed_at` YES. Indexes: INDEX(patient_id, started_at); INDEX(provider_id); INDEX(status).
**clinical_notes** (immutable once signed) — `encounter_id` FK; `type` enum NO = `soap | progress | nursing`; `content` JSONB NO (S/O/A/P sections); `signed_by` FK YES; `signed_at` YES (NULL=draft); `amends_note_id` FK→clinical_notes YES (amendments). Index: INDEX(encounter_id).
**vitals** — `encounter_id` FK; `type` enum NO = `bp | hr | temp | spo2 | weight | height | bmi | …`; `value_num` NUMERIC(10,2) YES; `value_text` YES (e.g., 120/80 for BP); `unit` NO; `taken_at` NO. Indexes: INDEX(encounter_id); INDEX(type, taken_at).
**diagnoses** — `encounter_id` FK; `icd_code` NO; `description` NO; `is_primary` BOOL NO default false. Indexes: INDEX(encounter_id); INDEX(icd_code).
**procedures** — `encounter_id` FK; `code` YES; `description` NO; `performed_at` YES; `data` JSONB YES (specialty detail, e.g., per-tooth). Index: INDEX(encounter_id).
**referrals** — `encounter_id` FK; `to_department_id` FK YES; `external_to` YES; `reason` NO. Index: INDEX(encounter_id).
**follow_ups** — `encounter_id` FK; `due_date` DATE YES; `instructions` YES; `appointment_id` FK YES (once booked). Index: INDEX(encounter_id).
**prescriptions** — `encounter_id` FK; `patient_id` FK; `status` enum NO = `draft | signed | dispensed | cancelled`; `signed_by` FK YES; `signed_at` YES. Indexes: INDEX(encounter_id); INDEX(patient_id).
**prescription_items** — `prescription_id` FK; `drug_id` FK→drugs YES (null for free-text); `drug_text` YES (free-text drug name); `dose` NO; `route` YES; `frequency` NO; `duration` NO; `instructions` YES. Index: INDEX(prescription_id).

#### 8.5.7 Forms

**form_templates** — `name` NO; `specialty` YES; `category` YES = `intake | exam | consent | …`; `current_version_id` FK→form_versions YES; `is_active` BOOL NO default true. Index: INDEX(tenant_id).
**form_versions** (immutable versioned schema) — `template_id` FK; `version` INT NO (monotonic per template); `schema_json` JSONB NO (field defs, validation, conditions); `role_restrictions` JSONB YES (allowed roles to complete); `published_at` YES. Index: UNIQUE(template_id, version).
**form_submissions** — `form_version_id` FK; `encounter_id` FK YES; `patient_id` FK YES; `data_json` JSONB NO; `submitted_by` FK YES. Indexes: INDEX(encounter_id); INDEX(patient_id); GIN(data_json).

#### 8.5.8 Laboratory

**lab_test_groups** — `name` NO; `code` YES (UNIQUE per tenant). Index: INDEX(tenant_id).
**lab_tests** — `group_id` FK YES; `code` NO (UNIQUE per tenant); `name` NO; `specimen` YES (e.g., blood, urine); `unit` YES; `reference_range` JSONB YES (age/sex-aware); `price` NUMERIC(12,2) YES. Indexes: UNIQUE(tenant_id, code); INDEX(group_id).
**lab_orders** — `encounter_id` FK YES; `patient_id` FK; `branch_id` FK; `ordered_by` FK→users; `status` enum NO = `ordered | collected | in_process | resulted | cancelled`. Indexes: INDEX(patient_id); INDEX(branch_id, status).
**lab_order_items** — `order_id` FK; `test_id` FK→lab_tests. Index: INDEX(order_id).
**lab_samples** — `order_id` FK; `test_id` FK; `barcode` NO (UNIQUE per tenant); `status` enum NO = `pending | collected | received | in_process | resulted`; `collected_at` YES. Indexes: UNIQUE(tenant_id, barcode); INDEX(order_id).
**lab_results** — `sample_id` FK; `value_num` NUMERIC(14,4) YES; `value_text` YES; `unit` YES; `flag` enum YES = `normal | high | low | critical`; `state` enum NO = `entered | validated | approved`; `entered_by` FK YES; `validated_by` FK YES; `approved_by` FK YES; `source` enum NO = `manual | csv | device`. Indexes: INDEX(sample_id); INDEX(state).

#### 8.5.9 Pharmacy

**drugs** — `name` NO; `generic_name` YES; `classification` YES (ATC/therapeutic class); `form` YES = `tablet | syrup | injection | …`; `strength` YES; `unit` YES; `is_controlled` BOOL NO default false. Indexes: INDEX(tenant_id); trigram on name.
**drug_batches** (branch-scoped) — `drug_id` FK; `branch_id` FK; `batch_no` NO; `expiry_date` DATE NO; `qty_on_hand` NUMERIC(14,2) NO default 0; `cost_price` NUMERIC(12,2) YES; `sale_price` NUMERIC(12,2) YES. Indexes: INDEX(drug_id, branch_id); INDEX(expiry_date).
**suppliers** — `name` NO; `contact` JSONB YES. Index: INDEX(tenant_id).
**purchase_orders** (pharmacy + inventory) — `supplier_id` FK; `branch_id` FK; `status` enum NO = `draft | sent | received | cancelled`; `total` NUMERIC(14,2) YES. Indexes: INDEX(supplier_id); INDEX(branch_id, status).
**po_items** — `po_id` FK; `drug_id` FK YES; `item_id` FK→inventory_items YES; `qty` NUMERIC(14,2) NO; `unit_cost` NUMERIC(12,2) YES. Index: INDEX(po_id).
**goods_receipts** — `po_id` FK; `received_by` FK→users; `received_at` NO; `notes` YES. Index: INDEX(po_id).
**dispenses** — `prescription_id` FK YES (null for OTC); `branch_id` FK; `patient_id` FK YES; `dispensed_by` FK→users; `dispensed_at` NO. Indexes: INDEX(prescription_id); INDEX(branch_id).
**dispense_items** — `dispense_id` FK; `batch_id` FK→drug_batches; `qty` NUMERIC(14,2) NO; `unit_price` NUMERIC(12,2) YES. Index: INDEX(dispense_id).
**otc_sales** — `dispense_id` FK; `invoice_id` FK→invoices YES. Index: INDEX(dispense_id).

#### 8.5.10 Inventory

**inventory_items** (non-drug consumables/supplies) — `name` NO; `sku` YES (UNIQUE per tenant); `uom` NO (unit of measure); `reorder_level` NUMERIC(14,2) YES. Index: UNIQUE(tenant_id, sku).
**stock_levels** — `item_id` FK; `branch_id` FK; `on_hand` NUMERIC(14,2) NO default 0. Index: UNIQUE(item_id, branch_id).
**stock_transfers** — `item_id` FK; `from_branch_id` FK→branches; `to_branch_id` FK→branches; `qty` NUMERIC(14,2) NO; `status` enum NO = `requested | dispatched | received | cancelled`. Indexes: INDEX(item_id); INDEX(from_branch_id); INDEX(to_branch_id).
**purchase_requests** — `branch_id` FK; `item_id` FK YES; `drug_id` FK YES; `qty` NUMERIC(14,2) NO; `status` enum NO = `open | approved | ordered | closed`. Index: INDEX(branch_id, status).
**stock_counts** — `branch_id` FK; `item_id` FK YES; `batch_id` FK→drug_batches YES; `counted_qty` NUMERIC(14,2) NO; `system_qty` NUMERIC(14,2) NO; `variance` NUMERIC(14,2) NO (counted − system); `counted_by` FK→users. Index: INDEX(branch_id).

#### 8.5.11 Finance

**charges** — `patient_id` FK; `encounter_id` FK YES; `branch_id` FK; `source` enum NO = `consultation | lab | pharmacy | procedure | package`; `source_ref` UUID YES (id of originating record); `description` NO; `amount` NUMERIC(12,2) NO; `status` enum NO = `pending | invoiced | void`. Indexes: INDEX(patient_id); INDEX(encounter_id); INDEX(branch_id, status).
**invoices** — `patient_id` FK; `branch_id` FK; `number` NO (human-readable, UNIQUE per tenant); `status` enum NO = `draft | issued | partially_paid | paid | void`; `subtotal` NUMERIC(14,2) NO; `discount_total` NUMERIC(14,2) NO default 0; `tax_total` NUMERIC(14,2) NO default 0; `total` NUMERIC(14,2) NO; `issued_at` YES. Indexes: UNIQUE(tenant_id, number); INDEX(patient_id); INDEX(branch_id, status).
**invoice_lines** — `invoice_id` FK; `charge_id` FK YES; `description` NO; `qty` NUMERIC(12,2) NO default 1; `unit_price` NUMERIC(12,2) NO; `amount` NUMERIC(14,2) NO. Index: INDEX(invoice_id).
**payments** — `invoice_id` FK; `method` enum NO = `cash | card | gateway | insurance`; `amount` NUMERIC(14,2) NO; `reference` YES (gateway/txn ref); `received_by` FK YES; `received_at` NO. Index: INDEX(invoice_id).
**refunds** — `payment_id` FK; `amount` NUMERIC(14,2) NO; `reason` NO; `refunded_by` FK→users. Index: INDEX(payment_id).
**price_lists** — `branch_id` FK YES (NULL=tenant default); `service_code` NO; `description` YES; `price` NUMERIC(12,2) NO. Index: UNIQUE(tenant_id, branch_id, service_code).
**discounts** — `code` YES; `type` enum NO = `percent | fixed`; `value` NUMERIC(12,2) NO; `requires_approval` BOOL NO default true. Index: INDEX(tenant_id).

#### 8.5.12 Insurance

**insurance_providers** — `name` NO; `contact` JSONB YES. Index: INDEX(tenant_id).
**coverage_plans** — `provider_id` FK; `name` NO; `copay_rule` JSONB YES; `covered_services` JSONB YES. Index: INDEX(provider_id).
**claims** — `invoice_id` FK; `coverage_plan_id` FK; `status` enum NO = `prepared | submitted | approved | rejected | reimbursed`; `amount` NUMERIC(14,2) NO (claimed); `submitted_at` YES. Indexes: INDEX(invoice_id); INDEX(coverage_plan_id); INDEX(status).
**claim_items** — `claim_id` FK; `invoice_line_id` FK→invoice_lines; `covered_amount` NUMERIC(14,2) NO. Index: INDEX(claim_id).
**reimbursements** — `claim_id` FK; `amount` NUMERIC(14,2) NO; `reference` YES; `received_at` NO. Index: INDEX(claim_id).

#### 8.5.13 Platform Services

**notifications** — `channel` enum NO = `email | sms | in_app | push`; `recipient` NO (address/number/user id); `template` NO (template key); `payload` JSONB YES; `status` enum NO = `queued | sent | failed`; `attempts` INT NO default 0; `sent_at` YES. Indexes: INDEX(tenant_id, status); INDEX(channel).
**reports** — `type` NO (report key); `params` JSONB YES (filters); `status` enum NO = `queued | ready | failed`; `s3_key` YES (generated file); `requested_by` FK→users. Index: INDEX(tenant_id, type).
**settings** — `scope` enum NO = `tenant | branch | user`; `scope_id` UUID YES (branch_id or user_id when applicable); `key` NO; `value` JSONB NO. Index: UNIQUE(tenant_id, scope, scope_id, key).
**event_outbox** — `aggregate_type` NO (e.g., encounter); `aggregate_id` UUID NO; `event_type` NO (routing key); `payload` JSONB NO; `sequence` BIGSERIAL NO (per-aggregate ordering); `dispatched_at` YES (NULL=pending). Indexes: INDEX(dispatched_at); INDEX(aggregate_type, aggregate_id).

### 8.6 Relationships & Referential Integrity
- All FKs explicit with **ON DELETE RESTRICT by default**; soft delete used instead of cascading hard deletes for clinical/financial data.
- Tenant-owned FKs reference rows within the same tenant; repository layer guarantees same-tenant joins.
- One-to-many: tenant→branches→departments; patient→encounters; encounter→notes/vitals/diagnoses/prescriptions; order→samples→results.
- Many-to-many via join tables: roles↔permissions (`role_permissions`), users↔roles-with-scope (`user_role_scopes`).

### 8.7 Indexing Strategy
- Every tenant-owned table indexed on `tenant_id` (often composite prefix, e.g., `(tenant_id, created_at)`).
- All FKs indexed.
- Search: **GIN trigram on patient name and drug name; OpenSearch is the primary full-text/search surface**, kept in sync via the indexer worker.
- Hot lookups: composite indexes match predicates — `queue_entries(department_id, state, priority, enqueued_at)`, `appointments(branch_id, starts_at)`.
- Partial indexes on `deleted_at IS NULL` keep active-row scans cheap.

### 8.8 Partitioning Strategy (Table 8.3 — introduced at Phase B/C as volume warrants)

| Table | Partitioning | Rationale |
|---|---|---|
| audit_logs | RANGE by created_at (monthly) | High write volume; time-based retention/pruning |
| notifications | RANGE by created_at (monthly) | High churn; old rows archivable |
| event_outbox | RANGE by created_at (weekly) or pruned | Short-lived rows; fast dispatch scans |
| encounters / vitals / lab_results | By tenant (hash) at scale; optional time sub-partition | Spread very large tenants; bound index size |

### 8.9 Tenant Isolation Strategy
- Mandatory `tenant_id` on every tenant-owned table; tenancy context injects it into every query parameter set.
- Repository layer is the single choke point; queries generated to always include tenant predicate — omission impossible in app code.
- Optional PostgreSQL RLS: policies keyed on a session GUC **`app.tenant_id`** provide DB-level defence in depth.
- Connection pooling sets the tenant GUC per transaction when RLS is enabled.

### 8.10 Soft Delete Strategy
- Clinical and financial tables use `deleted_at`; queries filter `deleted_at IS NULL` via repository layer.
- Reference/lookup data may use an `is_active` flag where history is unnecessary.
- Hard deletion reserved for purge operations under the data-retention policy (e.g., post-cancellation grace expiry).

### 8.11 Audit Strategy
- Every mutation publishes an audit event; audit consumer writes append-only rows to `audit_logs` (no updates/deletes).
- Audit captures actor, tenant, branch, action, target, payload diff, IP, timestamp — **FR-AUD-01 / FR-AUD-02**.
- Sensitive reads (e.g., viewing a patient record) also audited where required for compliance.
- Tamper evidence: rows immutable; optional hash-chaining links each entry to the previous for the tenant.

### 8.12 Migration Strategy
- Versioned, reversible migrations (**goose/atlas**) checked into repo, run in CI/CD before deploy.
- **Expand/contract** backward-compatible migrations: add columns + backfill before switching reads, drop later, so rolling deploys never break.
- SQLC regenerates typed query code from updated schema; CI check fails build if generated code is stale.
- Large backfills run as background jobs in batches to avoid long locks.

---

## Key Cross-References & Stack Component Usage (engineer notes)

- **Redis** — (1) caching + sessions (5.2 data layer); (2) rate-limiting token bucket in middleware order 4 (7.7).
- **RabbitMQ** — topic exchange per environment (7.8); transactional outbox relay publishes to it; routing key `<module>.<aggregate>.<event>`; DLQ after N attempts; publisher confirms; per-aggregate ordering via `event_outbox.sequence`.
- **OpenSearch** — primary full-text/search + analytics surface (5.2, 8.7); kept in sync via indexer worker reacting to events (e.g., `PatientRegistered`); Reporting/Analytics can run off it independently (extraction order 4).
- **S3** — file storage: `clinics.logo_s3_key`, `attachments.s3_key`, `reports.s3_key`; frontend file uploads via S3 presigned URLs (Table 6.3).
- **Kubernetes** — stateful operators for PG/Redis/RabbitMQ/OpenSearch; HPA on CPU + latency (API) and queue depth (workers); secrets via Kubernetes secrets (7.10).
- **PostgreSQL** — system of record; UUID v7 PKs; RLS GUC `app.tenant_id`; range/hash partitioning; pgx pool + tx manager in kernel/db.
- **Observability** — Loki (logs), Prometheus (RED metrics, queue depth, DB pool), OpenTelemetry (tracing client→API→worker).
- **Referenced requirement IDs:** FR-TEN-03 (feature-flag short-circuit / module disabled), FR-FRM (form builder versioned JSON schema, §4.3.8 in Part 1), FR-AUD-01 / FR-AUD-02 (audit capture). DevOps/testing/roadmap are referenced as "later part" specs (Phase B/C scaling milestones cited for partitioning and large-tenant isolation); no standalone DevOps/testing/roadmap section appears in this Part 2.