# Source: Clinic_SaaS_Blueprint_Part-2.docx

Clinic Management SaaS Platform

Implementation-Ready Blueprint

Part 2 of 2 — System, Frontend & Backend Architecture, Database Design & ERD

| Document | Part 2: System Architecture · Frontend Architecture · Backend Architecture · Database Design · ERD |
| --- | --- |
| Sections | 5 – 8 (continues from Part 1) |
| Architecture | Modular monolith, microservice-ready, event-driven, multi-tenant |
| Stack | React/TypeScript/Vite · Go/Gin/SQLC · PostgreSQL · Redis · RabbitMQ · OpenSearch · S3 · Docker/Kubernetes |
| Diagrams | Each architecture diagram and ERD is on its own full landscape page |
| Status | Implementation-ready draft v3 |

# Contents

5. System Architecture

5.1 Architectural Principles

5.2 High-Level Architecture

5.3 Module Boundaries & Dependency Rules

5.4 Top-Level Module Structure

5.5 Event-Driven Design

5.6 Service Interaction Model

5.7 Multi-Tenancy Strategy

5.8 Deployment Topology

5.9 Cross-Cutting Concerns

5.10 Microservice Extraction Path

6. Frontend Architecture

6.1 Overview & Principles

6.2 Folder Structure (Feature-Sliced)

6.3 Component Architecture

6.4 State Management Strategy

6.5 API Layer Design

6.6 Form Strategy

6.7 Routing & Route Protection

6.8 Authentication Flow

6.9 Error Handling Strategy

7. Backend Architecture

7.1 Overview & Principles

7.2 Layered Architecture

7.3 Project Structure

7.4 Repository Layer (SQLC)

7.5 Service Layer

7.6 HTTP Layer

7.7 Middleware Layer

7.8 Event Layer

7.9 Background Job Layer

7.10 Configuration & Secrets

7.11 Error Handling Strategy

8. Database Design

8.1 Design Principles

8.2 Conventions & Standard Columns

8.3 Entity-Relationship Diagrams

8.4 Full Table Catalog

8.5 Detailed Table Specifications

8.6 Relationships & Referential Integrity

8.7 Indexing Strategy

8.8 Partitioning Strategy

8.9 Tenant Isolation Strategy

8.10 Soft Delete Strategy

8.11 Audit Strategy

8.12 Migration Strategy

# 5. System Architecture

A modular monolith with microservice-ready seams: one deployable today, cleanly extractable tomorrow. API-first, event-driven, and multi-tenant from the first commit.

## 5.1 Architectural Principles

- Modular monolith first. One Go binary (plus worker binary) keeps operations simple at low scale; strict internal boundaries preserve the option to extract services later.

- Microservice-ready seams. Modules never reach into each other's tables; they communicate through service interfaces and domain events, so a module can become a service with minimal change.

- API-first. Every capability is exposed through the REST API; the web client is just one consumer, alongside future mobile apps and integrators.

- Event-driven. State changes publish domain events; side effects (billing charges, notifications, search indexing, audit) react asynchronously, decoupling write paths from downstream work.

- Multi-tenant by construction. Tenant context is resolved once at the edge and enforced in the data layer; cross-tenant access is impossible by contract, not by convention.

- Twelve-factor & cloud-native. Stateless services, config from environment, secrets from a manager, horizontal scaling, and container-based deployment.

## 5.2 High-Level Architecture

Requests enter through TLS-terminating ingress and an API gateway responsible for routing, rate limiting, and authentication. The gateway forwards to the modular-monolith API, whose modules share a kernel (tenancy, auth, persistence, events) but own their domains. Writes publish events to an internal bus that bridges to RabbitMQ; workers handle notifications, search indexing, and report generation. PostgreSQL is the system of record; Redis provides caching and sessions; OpenSearch powers search and analytics; S3-compatible storage holds files.

Figure 5.1 — High-level system architecture across client, edge, application, async, and data layers.

| Layer | Responsibility | Key Technology |
| --- | --- | --- |
| Client | Render UI, capture input, hold session | React/TS SPA, Patient Portal, API integrators |
| Edge | TLS, routing, rate limiting, authentication | Ingress, API gateway |
| Application | Domain logic across modules; publish events | Go/Gin modular monolith |
| Async | Decoupled side effects and heavy jobs | RabbitMQ + worker pods |
| Data | Durable state, cache, search, files | PostgreSQL, Redis, OpenSearch, S3 |
| External | Third-party capabilities | Email/SMS, payment gateway, lab devices |

Table 5.1 — Layer responsibilities.

## 5.3 Module Boundaries & Dependency Rules

The application is partitioned into bounded modules grouped by domain. Each module owns its tables, services, and HTTP handlers. The dependency rules below are enforced in code review and, where possible, by package-import linting.

- Own your data. A module reads and writes only its own tables. It never issues SQL against another module's tables.

- Talk through interfaces. Synchronous cross-module needs go through a published service interface (a Go interface), not a direct struct/DB dependency.

- Prefer events for side effects. Anything that can be eventually consistent (charges, notifications, indexing, audit) is driven by a domain event, not an inline call.

- Depend only inward. Modules depend on the shared kernel (tenancy, auth, persistence, events, errors) but the kernel never depends on a module.

- No shared mutable state. Modules share nothing but the kernel and the event contracts; this is what makes later extraction mechanical.

Figure 5.2 — Event-driven interaction: modules publish domain events; consumers react asynchronously.

## 5.4 Top-Level Module Structure

The Go module layout reflects the bounded modules; the full internal tree is specified in the Backend Architecture (Section 7.3).

| clinicsaas/ ├─ cmd/ │   ├─ api/            # API server entrypoint │   └─ worker/         # async worker entrypoint ├─ internal/ │   ├─ kernel/         # shared: tenancy, auth, db, events, errors, config │   ├─ identity/       # auth, users, roles, tenants (bounded module) │   ├─ org/            # clinics, branches, departments │   ├─ patient/        # patients, search, attachments │   ├─ scheduling/     # appointments, queue │   ├─ clinical/       # consultation, EMR, notes, vitals, dx, rx, forms │   ├─ laboratory/     # LIS │   ├─ pharmacy/       # drugs, batches, dispensing │   ├─ inventory/      # stock, transfers, purchasing │   ├─ finance/        # billing, invoicing, payments, insurance │   └─ platform/       # notifications, reporting, analytics, audit, settings └─ ... |
| --- |

## 5.5 Event-Driven Design

Events are first emitted to an in-process dispatcher and persisted via the transactional outbox pattern: the event row is written in the same database transaction as the state change, then a relay publishes it to RabbitMQ. This guarantees at-least-once delivery without dual-write inconsistency. Consumers are idempotent (keyed by event id).

#### Representative domain events

| Event | Published By | Consumed By (effect) |
| --- | --- | --- |
| PatientRegistered | Patient | Search Indexer (index), Audit |
| AppointmentBooked | Scheduling | Notifications (reminder), Audit |
| PatientCheckedIn | Scheduling/Queue | Queue (enqueue), Analytics |
| EncounterClosed | Clinical | Finance (consultation charge), Notifications, Audit |
| LabResultApproved | Laboratory | Clinical (attach to encounter), Notifications (patient), Finance (lab charge) |
| MedicationDispensed | Pharmacy | Finance (pharmacy charge), Inventory (decrement), Audit |
| InvoiceIssued | Finance | Notifications (receipt), Analytics |
| PaymentCaptured | Finance | Analytics (revenue), Audit |

Table 5.2 — Core event catalog (extended per module in later parts).

## 5.6 Service Interaction Model

Synchronous calls are reserved for request/response work the user is waiting on (e.g., reading an encounter, validating a booking). Everything that can be deferred is asynchronous. The sequence below illustrates closing a consultation:

#### Figure 5.3 — “Close encounter” interaction

| Doctor signs note (sync write) →  Clinical commits + writes outbox EncounterClosed →  Relay → RabbitMQ →  Finance adds consultation charge →  Notifications queues patient summary →  Audit records the action |
| --- |

## 5.7 Multi-Tenancy Strategy

The platform uses a shared database, shared schema model with a mandatory tenant_id on every tenant-owned table. This maximises density and operational simplicity for thousands of small tenants. Isolation is enforced at two levels:

- Repository-enforced predicates. Every query is generated to include the tenant (and branch where relevant) predicate; the repository layer injects tenant context so a query physically cannot omit it.

- Optional PostgreSQL Row-Level Security (RLS). As defence in depth, RLS policies keyed on a session tenant GUC can be enabled so the database itself rejects cross-tenant rows.

Scaling path: at Phase B/C, large tenants can be moved to dedicated schemas or shards using the same code, since the tenant key is uniform. Hot tables are partitioned by tenant and/or time (see Section 8.8). A small number of very large tenants MAY be isolated onto dedicated database clusters without code change.

| Concern | Approach |
| --- | --- |
| Isolation | tenant_id on every row + repository predicates (+ optional RLS) |
| Noisy neighbour | Per-tenant rate limits at gateway; connection pooling; query budgets |
| Large tenants | Schema-per-tenant or dedicated cluster migration without code change |
| Onboarding | Row inserts only — no per-tenant schema creation needed at base tier |
| Data residency (future) | Tenant → region routing at the edge; region-pinned clusters |

Table 5.3 — Multi-tenancy decisions.

## 5.8 Deployment Topology

Services run as stateless, horizontally scalable deployments on Kubernetes behind an ingress controller. API pods scale via the Horizontal Pod Autoscaler on CPU and request latency; worker pods scale on queue depth. Stateful services (PostgreSQL, Redis, RabbitMQ, OpenSearch) are managed or run as operators; object storage is external.

Figure 5.4 — Kubernetes deployment topology (detailed DevOps spec in a later part).

## 5.9 Cross-Cutting Concerns

| Concern | Where Handled | Notes |
| --- | --- | --- |
| AuthN/AuthZ | Gateway + middleware | JWT verify at edge; role+scope+flag checks in service layer |
| Tenant resolution | Middleware (kernel) | Resolved from token claims into request context |
| Logging | Middleware + Loki | Structured JSON logs with tenant/request correlation IDs |
| Metrics | Prometheus | RED metrics per endpoint; queue depth; DB pool stats |
| Tracing | OpenTelemetry | Trace IDs propagate client → API → worker |
| Config | Env + secrets manager | No secrets in code; per-environment overrides |
| Audit | Event consumer | Immutable append-only audit store |

Table 5.4 — Cross-cutting concerns and ownership.

## 5.10 Microservice Extraction Path

When a module's scale or team ownership justifies it, extraction follows a strangler approach: stand up the module as its own deployable, route its API namespace to it at the gateway, and switch its event publishing/consumption to the shared broker (already the transport). Because modules already own their data and communicate via interfaces and events, extraction is largely a packaging and routing exercise.

| Extraction Order | Module | Why It Extracts Cleanly |
| --- | --- | --- |
| 1 | Notifications | Already event-driven, stateless, no inbound coupling |
| 2 | Laboratory (LIS) | Self-contained domain; device integration benefits from isolation |
| 3 | Pharmacy + Inventory | Stock-heavy, distinct scaling profile |
| 4 | Reporting/Analytics | Read-heavy; can run off replicas/OpenSearch independently |
| 5 | Finance | Sensitive and high-value; isolate once volume warrants |

Table 5.5 — Recommended extraction sequence.

# 6. Frontend Architecture

A feature-sliced React + TypeScript SPA: TanStack Query owns server state, React Hook Form + Zod own forms and validation, and every route is gated by role, scope, and feature flag.

## 6.1 Overview & Principles

- Feature-based structure. Code is organised by domain feature, not by technical type, so a feature is self-contained and easy to find, change, or remove.

- Server state vs. UI state. Remote data lives in TanStack Query (cache, refetch, mutations); ephemeral UI state stays local or in a light store. They are never conflated.

- Typed end-to-end. API responses are validated with Zod at the boundary, producing TypeScript types the rest of the app trusts.

- Composition over configuration. ShadCN UI primitives are composed into feature components; Tailwind provides the design tokens.

- Guard at the route. Authentication, role/scope, and feature-flag checks happen at the route boundary, so feature code assumes it is allowed to render.

## 6.2 Folder Structure (Feature-Sliced)

| src/ ├─ app/ │   ├─ router.tsx            # route tree + lazy imports │   ├─ providers.tsx         # QueryClient, Auth, Theme, Toaster │   └─ layouts/              # AppShell, AuthLayout, BranchLayout ├─ features/ │   ├─ auth/ │   │   ├─ api.ts            # login, refresh, logout (typed) │   │   ├─ hooks.ts          # useLogin, useSession │   │   ├─ components/ │   │   └─ pages/            # LoginPage, MfaPage │   ├─ patients/ │   │   ├─ api.ts │   │   ├─ schemas.ts        # Zod schemas + inferred types │   │   ├─ hooks.ts          # usePatients, useCreatePatient │   │   ├─ components/       # PatientCard, DuplicateWarning │   │   └─ pages/            # PatientListPage, PatientFormPage │   ├─ appointments/  scheduling/  queue/ │   ├─ consultation/  emr/  prescriptions/  forms/ │   ├─ laboratory/  pharmacy/  inventory/ │   ├─ billing/  payments/  insurance/ │   └─ admin/         # tenant, branches, users, roles, settings ├─ components/ │   ├─ ui/                   # ShadCN primitives (button, dialog, table...) │   └─ common/               # DataTable, PageHeader, EmptyState, ErrorState ├─ lib/ │   ├─ api-client.ts         # fetch wrapper, interceptors, error envelope │   ├─ query.ts              # QueryClient config, query keys │   ├─ auth.ts               # token store, refresh logic │   ├─ rbac.ts               # can(role, action), scope helpers │   ├─ flags.ts              # useFeatureFlag() │   └─ form-renderer/        # dynamic JSON-schema form renderer ├─ hooks/                    # cross-cutting hooks (useDebounce, useScope) ├─ types/                    # shared/global types ├─ styles/                   # tailwind.css, tokens └─ main.tsx |
| --- |

## 6.3 Component Architecture

| Tier | Examples | Rules |
| --- | --- | --- |
| UI primitives | Button, Input, Dialog, Select (ShadCN) | Stateless, styled, no domain knowledge |
| Common components | DataTable, PageHeader, EmptyState, ErrorState, FormField | Reusable across features; no feature imports |
| Feature components | PatientCard, QueueBoard, EncounterPanel | Own a slice of a feature; use hooks for data |
| Pages | PatientListPage, ConsultationPage | Compose components; one per route; handle layout |
| Layouts | AppShell, BranchLayout | Navigation, scope switcher, outlet for pages |

Table 6.1 — Component tiers and boundaries.

## 6.4 State Management Strategy

| State Kind | Owner | Example |
| --- | --- | --- |
| Server/remote state | TanStack Query | Patient list, encounter, lab results |
| Form state | React Hook Form | Registration form, SOAP note, dynamic forms |
| Global UI state | Light store (Zustand) / Context | Active branch scope, theme, toasts |
| Local component state | useState/useReducer | Dialog open, tab selection |
| URL state | React Router params/search | Filters, pagination, selected ids |

Table 6.2 — State is classified and assigned a single owner to avoid duplication.

Query conventions. Query keys are structured and centralised (e.g., ['patients', { branchId, filters }]); mutations invalidate the minimal set of keys; optimistic updates are used for fast interactions (queue state, vitals) with rollback on error.

## 6.5 API Layer Design

A single typed API client wraps fetch and centralises concerns so feature code stays declarative:

- Auth interceptor. Attaches the access token; on 401, attempts a single refresh, retries once, then redirects to login.

- Tenant/scope headers. Active branch scope travels with each request where relevant.

- Error envelope normalisation. Server errors are parsed into a typed AppError { code, message, fields } consumed uniformly by UI.

- Zod parsing. Responses are validated against Zod schemas; a parse failure surfaces as a typed error rather than a silent shape mismatch.

- Pagination/filter helpers. Standard helpers serialise pagination, filtering, sorting, and search params consistently.

## 6.6 Form Strategy

Static forms use React Hook Form with a Zod resolver, giving a single source of truth for validation shared (in shape) with the backend. The dynamic form renderer interprets the form builder's versioned JSON schema (Section 4.3.8 / FR-FRM) at runtime: it maps each field type (text, number, date, checkbox, radio, dropdown, multi-select, file, signature) to a controlled component, applies conditional visibility rules, and builds a Zod schema on the fly from the field validation rules. Submitted data is stored against the captured schema version so historical records render exactly as entered.

| Field Type | Component | Validation Source |
| --- | --- | --- |
| text / textarea | Input / Textarea | min/max length, pattern (regex) |
| number | Numeric Input | min/max, integer/decimal |
| date / time | DatePicker / TimePicker | range, required |
| checkbox / radio | Checkbox / RadioGroup | required, allowed values |
| dropdown / multi-select | Select / MultiSelect | enum, min/max selections |
| file upload | FileDropzone (→ S3 presigned) | type, size limits |
| signature | SignaturePad (→ image) | required |

Table 6.3 — Dynamic form field mapping for the JSON-schema renderer.

## 6.7 Routing & Route Protection

React Router defines a nested route tree with lazy-loaded feature pages. A ProtectedRoute wrapper composes three guards, short-circuiting to the appropriate fallback:

- Authentication guard — no valid session → redirect to login (preserving intended destination).

- Authorisation guard — role/scope check via rbac.ts; insufficient → 403 view.

- Feature-flag guard — module disabled for tenant → hidden in nav and blocked with an upgrade prompt.

| <Route element={<ProtectedRoute />}>                 // auth required <Route element={<AppShell />}> <Route path="/patients" element={<PatientListPage />} /> <Route element={<RequireFlag flag="laboratory" />}> <Route element={<RequireRole anyOf={['lab_tech','lab_manager']} />}> <Route path="/lab/worklist" element={<LabWorklistPage />} /> </Route> </Route> </Route> </Route> |
| --- |

## 6.8 Authentication Flow

Access tokens are short-lived and held in memory; the refresh token is kept in an httpOnly cookie (or secure store) and rotated on use. The data flow below shows how a feature page reads and writes through the layers:

Figure 6.1 — Frontend data flow: route → feature → form/query → API client → backend.

#### Figure 6.2 — Token lifecycle

| Login → access + refresh issued →  Access in memory; refresh in httpOnly cookie →  401 → interceptor refreshes once →  Refresh rotates; retry request →  Refresh fails → clear + redirect to login |
| --- |

## 6.9 Error Handling Strategy

| Scope | Mechanism | User Experience |
| --- | --- | --- |
| Render errors | React error boundaries per layout/route | Friendly fallback + retry, error reported |
| Query errors | TanStack Query error state | Inline ErrorState with retry |
| Mutation errors | onError + typed AppError | Toast + field-level messages from envelope |
| Validation errors | Zod + RHF field errors | Inline messages next to fields |
| Auth errors | Interceptor (401/refresh) | Silent refresh or redirect to login |
| Network/offline | Query retry + offline indicator | Banner; reads served from cache where possible |

Table 6.4 — Layered error handling with explicit loading, empty, and error states on every screen.

# 7. Backend Architecture

Go + Gin + SQLC built as clean, layered, domain-oriented modules: HTTP handlers are thin, services hold the rules, repositories are compile-time-checked SQL, and side effects flow through events.

## 7.1 Overview & Principles

- Clean, layered architecture. Dependencies point inward: HTTP → service → domain → repository. Outer layers know inner ones, never the reverse.

- Domain-driven modules. Each bounded module (identity, patient, clinical, laboratory, …) owns its domain model, services, repositories, and handlers.

- Thin handlers, rich services. HTTP handlers parse/validate and delegate; all business rules and transactions live in the service layer.

- Compile-time-safe SQL. All queries are authored in SQL and generated by SQLC into typed Go; no hand-rolled string SQL, no ORM surprises.

- Explicit transactions and events. Services own transaction boundaries and write to the outbox in the same transaction as the state change.

## 7.2 Layered Architecture

Figure 7.1 — Backend layers: HTTP → middleware → service → domain/repository, with event and job layers.

| Layer | Responsibility | Depends On |
| --- | --- | --- |
| HTTP (Gin) | Routing, DTO binding, request validation, response shaping | Service interfaces |
| Middleware | Auth, tenant/scope resolution, rate limit, logging, recovery, audit context | Kernel |
| Service (use-case) | Business rules, transactions, feature-flag checks, event publication | Domain, repositories |
| Domain | Entities, value objects, invariants, domain events | Nothing (pure) |
| Repository (SQLC) | Typed queries with tenant predicates; mapping rows ↔ domain | Database driver |
| Event | Outbox write + publish to RabbitMQ | Kernel, broker |
| Background jobs | Consume events, run schedules; idempotent handlers | Services |

Table 7.1 — Layer responsibilities and permitted dependencies.

## 7.3 Project Structure

A representative bounded module (patient) is expanded to show the standard internal layout every module follows.

| clinicsaas/ ├─ cmd/ │   ├─ api/main.go                # wires kernel + modules, starts Gin │   └─ worker/main.go             # starts RabbitMQ consumers + schedulers ├─ internal/ │   ├─ kernel/ │   │   ├─ config/                # env loading, typed config │   │   ├─ auth/                  # JWT, password, MFA, token store │   │   ├─ tenancy/               # tenant/scope context + resolver │   │   ├─ db/                    # pgx pool, tx manager, RLS GUC set │   │   ├─ events/                # bus, outbox, publisher, consumer base │   │   ├─ httpx/                 # error envelope, pagination, middleware │   │   └─ audit/                 # audit event helper │   ├─ patient/ │   │   ├─ domain/                # Patient entity, value objects, events │   │   ├─ service/               # PatientService (use-cases), rules │   │   ├─ repo/ │   │   │   ├─ queries/           # *.sql files (SQLC source) │   │   │   └─ gen/               # SQLC-generated Go (do not edit) │   │   ├─ http/                  # handlers, DTOs, routes │   │   └─ ports.go               # interfaces this module exposes/consumes │   ├─ identity/ org/ scheduling/ clinical/ laboratory/ pharmacy/ │   ├─ inventory/ finance/ platform/   # same internal layout ├─ db/ │   ├─ migrations/                # versioned, reversible (goose/atlas) │   └─ sqlc.yaml ├─ api/openapi.yaml               # source of REST contract ├─ deploy/                        # Dockerfiles, k8s manifests, charts └─ go.mod |
| --- |

## 7.4 Repository Layer (SQLC)

Queries are written as SQL with SQLC annotations and compiled to typed Go. Every tenant-owned query takes tenant_id (and branch where relevant) as a parameter; the tenancy context supplies it so callers cannot forget it. Multi-statement work runs inside a transaction managed by the kernel tx manager.

| -- name: GetPatientByMRN :one SELECT * FROM patients WHERE tenant_id = $1 AND mrn = $2 AND deleted_at IS NULL;  -- name: SearchPatients :many SELECT * FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL AND (mrn ILIKE $2 OR phone ILIKE $2 OR (first_name \|\| ' ' \|\| last_name) ILIKE $2) ORDER BY last_name, first_name LIMIT $3 OFFSET $4; |
| --- |

- Generated code is never edited; query changes are made in SQL and regenerated.

- Repositories map SQLC rows to/from domain types; no domain logic leaks into SQL.

- The tx manager exposes WithTx(ctx, fn) so a service composes several repository calls atomically with the outbox write.

## 7.5 Service Layer

Services implement use-cases. A use-case typically: (1) authorises the action against role/scope/flag, (2) loads domain entities, (3) enforces invariants, (4) persists within a transaction, (5) writes domain events to the outbox, and (6) returns a result DTO. Example responsibilities for closing an encounter:

| Authorise (doctor + scope) →  Load encounter + validate state →  Apply note signing rules →  BEGIN tx: persist note + mark closed + outbox EncounterClosed →  COMMIT →  Return EncounterDTO |
| --- |

Feature flags. Services consult the flag resolver early; a disabled module short-circuits with a recoverable error before any work, matching FR-TEN-03.

## 7.6 HTTP Layer

- Routes are registered per module under a versioned prefix (e.g., /api/v1/patients).

- Handlers bind and validate request DTOs (struct tags + explicit checks), call the service, and map results/errors to the response envelope.

- Handlers contain no business logic; they are trivial to test and to move when a module is extracted.

#### Standard response & error envelope

| // success { "data": { ... }, "meta": { "page": 1, "pageSize": 20, "total": 134 } }  // error { "error": { "code": "PATIENT_DUPLICATE", "message": "A matching patient already exists", "fields": { "nationalId": "already in use" } } } |
| --- |

## 7.7 Middleware Layer

| Middleware | Order | Responsibility |
| --- | --- | --- |
| Recovery | 1 | Catch panics → 500 envelope; never crash the process |
| Request ID / Tracing | 2 | Assign correlation + trace IDs; propagate downstream |
| Structured Logging | 3 | Log method, path, status, latency, tenant, request id |
| Rate Limiting | 4 | Per-tenant and per-IP limits (Redis token bucket) |
| Authentication | 5 | Verify JWT; load principal into context |
| Tenant/Scope Resolution | 6 | Derive tenant + allowed branches/departments into context |
| Audit Context | 7 | Stamp actor/tenant for downstream audit events |

Table 7.2 — Middleware chain (outermost first).

## 7.8 Event Layer

Domain events are written to an outbox table inside the same transaction as the state change. A relay process polls the outbox and publishes to RabbitMQ, marking rows dispatched. This provides at-least-once delivery with no dual-write inconsistency. RabbitMQ uses a topic exchange; consumers bind to routing keys (e.g., clinical.encounter.closed) and are idempotent by event id.

| Element | Choice |
| --- | --- |
| Exchange | Topic exchange per environment |
| Routing key | <module>.<aggregate>.<event> (e.g., laboratory.result.approved) |
| Delivery | At-least-once; consumers idempotent (dedupe on event_id) |
| Reliability | Transactional outbox + relay; publisher confirms |
| Failure handling | Retry with backoff; dead-letter queue after N attempts |
| Ordering | Per-aggregate ordering via event sequence; no global order assumed |

Table 7.3 — Messaging topology and reliability.

## 7.9 Background Job Layer

- Event consumers. Workers subscribe to routing keys and invoke the relevant service use-case (e.g., add charge on EncounterClosed). Handlers are idempotent and safe to redeliver.

- Schedulers. Cron-style jobs handle appointment reminders, near-expiry pharmacy alerts, stock reorder checks, and report generation.

- Isolation. Workers run as a separate deployment (cmd/worker) so heavy async load never degrades request latency.

- Observability. Each job emits metrics (processed, failed, duration) and logs with the originating event id for traceability.

## 7.10 Configuration & Secrets

- Configuration is loaded from environment variables into a typed config struct validated at startup; the process fails fast on missing/invalid config.

- Secrets (DB credentials, JWT signing keys, provider API keys) come from a secrets manager / Kubernetes secrets, never from source or images.

- Per-environment overrides (dev/staging/prod) are layered; no environment-specific code branches.

## 7.11 Error Handling Strategy

| Error Class | Origin | HTTP | Envelope code example |
| --- | --- | --- | --- |
| Validation | Handler/DTO binding | 400 | VALIDATION_FAILED |
| Authentication | Auth middleware | 401 | UNAUTHENTICATED |
| Authorisation | Service guard | 403 | FORBIDDEN_SCOPE |
| Not found | Repository/service | 404 | PATIENT_NOT_FOUND |
| Conflict | Service invariant | 409 | PATIENT_DUPLICATE |
| Feature disabled | Flag resolver | 402/409 | MODULE_DISABLED |
| Rate limited | Rate-limit middleware | 429 | RATE_LIMITED |
| Internal | Unexpected | 500 | INTERNAL_ERROR |

Table 7.4 — Domain errors map to stable HTTP codes and machine-readable envelope codes.

# 8. Database Design

A single PostgreSQL schema, multi-tenant by tenant_id, normalised, soft-deleted, and fully audited. Every table carries standard columns; hot tables are partitionable; isolation is enforced in the repository layer and optionally by row-level security.

## 8.1 Design Principles

- PostgreSQL as system of record; 3NF by default, with JSONB only for genuinely dynamic data (form submissions, settings, audit payloads).

- Multi-tenant shared schema: every tenant-owned table has a non-null tenant_id; all access is tenant-filtered.

- Surrogate keys: UUID v7 primary keys (time-ordered, index-friendly) named id.

- Soft delete: clinical/financial rows use deleted_at; physical deletes are avoided to protect history and audit.

- Auditability: mutations emit audit events; the audit store is append-only.

- Money as NUMERIC(12,2); timestamps as TIMESTAMPTZ in UTC; enums as TEXT with CHECK constraints or reference tables.

## 8.2 Conventions & Standard Columns

To avoid repetition, the following standard columns appear on every tenant-owned table and are omitted from the per-table specs below unless they carry table-specific notes:

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| id | UUID | NO | PK, UUID v7, default generated |
| tenant_id | UUID | NO | FK → tenants(id); on every tenant-owned table; indexed |
| created_at | TIMESTAMPTZ | NO | default now() |
| updated_at | TIMESTAMPTZ | NO | default now(); maintained on update |
| created_by | UUID | YES | FK → users(id); actor who created the row |
| deleted_at | TIMESTAMPTZ | YES | soft-delete marker; NULL = active |

Table 8.1 — Standard columns present on all tenant-owned tables.

Naming. snake_case tables (plural) and columns; foreign keys named <referent>_id; junction tables named <a>_<b>; enums documented inline. All foreign keys are indexed; all unique business keys are scoped by tenant_id.

## 8.3 Entity-Relationship Diagrams

The data model is presented as four domain ERDs for readability. Crow's-foot notation shows cardinality; PK/FK markers identify keys. Standard columns are omitted from the diagrams.

Figure 8.1 — ERD: Tenancy, Organisation & Identity/Access.

Figure 8.2 — ERD: Patient, Scheduling, Clinical/EMR & Forms.

Figure 8.3 — ERD: Laboratory, Pharmacy & Inventory.

Figure 8.4 — ERD: Finance & Insurance.

## 8.4 Full Table Catalog

Every table in the core schema, by domain. Detailed column specifications follow in Section 8.5.

| Domain | Tables |
| --- | --- |
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

Table 8.2 — Full table catalog (66 tables across 13 domains).

## 8.5 Detailed Table Specifications

Distinctive columns are specified per table; standard columns (Table 8.1) are implied. “Null” indicates whether NULL is permitted.

### 8.5.1 Tenancy & Subscription

#### tenants

Top-level isolated account (a clinic or clinic group).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO | Display name |
| slug | TEXT | NO | URL-safe unique identifier; UNIQUE |
| status | TEXT (enum) | NO | created \| onboarding \| active \| suspended \| cancelled |
| plan_id | UUID | NO | FK → plans(id) |
| region | TEXT | YES | Data-residency region (future routing) |
| onboarded_at | TIMESTAMPTZ | YES | Set when onboarding completes |

Indexes: UNIQUE(slug); INDEX(status); INDEX(plan_id)

#### plans

Subscription tier definitions and limits (platform-managed).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| code | TEXT | NO | starter \| professional \| business \| enterprise; UNIQUE |
| name | TEXT | NO | Display name |
| branch_limit | INTEGER | YES | NULL = unlimited |
| user_limit | INTEGER | YES | NULL = unlimited |
| storage_gb | INTEGER | YES | NULL = custom |
| audit_retention_days | INTEGER | NO | Plan audit retention |
| price_monthly | NUMERIC(12,2) | YES | Reference price |

Indexes: UNIQUE(code)

#### subscriptions

A tenant's active subscription state and billing cycle.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| tenant_id | UUID | NO | FK → tenants(id) |
| plan_id | UUID | NO | FK → plans(id) |
| status | TEXT (enum) | NO | trialing \| active \| past_due \| cancelled |
| current_period_start | TIMESTAMPTZ | NO |  |
| current_period_end | TIMESTAMPTZ | NO |  |
| cancel_at | TIMESTAMPTZ | YES | Scheduled cancellation |

Indexes: INDEX(tenant_id); INDEX(status)

#### feature_flags

Per-tenant module enablement and overrides.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| tenant_id | UUID | NO | FK → tenants(id) |
| flag | TEXT | NO | pharmacy \| laboratory \| inventory \| insurance \| telemedicine \| hr \| finance_advanced |
| enabled | BOOLEAN | NO | Resolved enablement |
| source | TEXT (enum) | NO | plan \| addon \| override |

Indexes: UNIQUE(tenant_id, flag)

#### billing_accounts

Payment/billing details for the subscription (vendor-side).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| tenant_id | UUID | NO | FK → tenants(id); UNIQUE |
| external_customer_id | TEXT | YES | Gateway customer reference |
| currency | TEXT | NO | ISO 4217 |
| billing_email | TEXT | NO |  |

Indexes: UNIQUE(tenant_id)

### 8.5.2 Organisation

#### clinics

Clinic profile and global settings within a tenant.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO |  |
| timezone | TEXT | NO | IANA TZ |
| locale | TEXT | NO | BCP-47 |
| logo_s3_key | TEXT | YES | Object storage key |

Indexes: INDEX(tenant_id)

#### branches

Physical location belonging to a tenant.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| clinic_id | UUID | NO | FK → clinics(id) |
| name | TEXT | NO |  |
| code | TEXT | NO | Short branch code; UNIQUE per tenant |
| address | TEXT | YES |  |
| phone | TEXT | YES |  |
| opening_hours | JSONB | YES | Per-day hours |
| is_active | BOOLEAN | NO | default true |

Indexes: UNIQUE(tenant_id, code); INDEX(clinic_id)

#### departments

Specialty/functional unit within a branch.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | NO | FK → branches(id) |
| name | TEXT | NO |  |
| specialty | TEXT | YES | e.g., pediatrics, dental |
| default_form_template_id | UUID | YES | FK → form_templates(id) |

Indexes: INDEX(branch_id)

#### resources

Bookable resources (rooms, chairs, equipment).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | NO | FK → branches(id) |
| department_id | UUID | YES | FK → departments(id) |
| name | TEXT | NO |  |
| type | TEXT (enum) | NO | room \| chair \| equipment |

Indexes: INDEX(branch_id); INDEX(department_id)

### 8.5.3 Identity & Access

#### users

Staff account scoped to a tenant.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| email | TEXT | NO | Login identifier; UNIQUE per tenant |
| password_hash | TEXT | YES | Argon2id; NULL until invitation accepted |
| full_name | TEXT | NO |  |
| status | TEXT (enum) | NO | invited \| active \| suspended \| deactivated |
| mfa_enabled | BOOLEAN | NO | default false |
| mfa_secret | TEXT | YES | Encrypted TOTP secret |
| last_login_at | TIMESTAMPTZ | YES |  |
| failed_attempts | INTEGER | NO | default 0; lockout threshold |

Indexes: UNIQUE(tenant_id, email); INDEX(status)

#### roles

Role definitions (system + custom).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| code | TEXT | NO | e.g., doctor, receptionist; UNIQUE per tenant |
| name | TEXT | NO |  |
| is_system | BOOLEAN | NO | System roles are immutable |

Indexes: UNIQUE(tenant_id, code)

#### permissions

Atomic permission catalog (global, not tenant-owned).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| code | TEXT | NO | e.g., patient.create, lab.result.approve; UNIQUE |
| description | TEXT | YES |  |

Indexes: UNIQUE(code)

#### role_permissions

Join of roles to permissions.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| role_id | UUID | NO | FK → roles(id) |
| permission_id | UUID | NO | FK → permissions(id) |

Indexes: UNIQUE(role_id, permission_id)

#### user_role_scopes

Assignment of a role to a user within a scope.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| user_id | UUID | NO | FK → users(id) |
| role_id | UUID | NO | FK → roles(id) |
| branch_id | UUID | YES | NULL = tenant-wide |
| department_id | UUID | YES | NULL = all departments in scope |

Indexes: INDEX(user_id); UNIQUE(user_id, role_id, branch_id, department_id)

#### sessions

Refresh-token sessions for rotation/revocation.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| user_id | UUID | NO | FK → users(id) |
| refresh_token_hash | TEXT | NO | Hashed token |
| user_agent | TEXT | YES |  |
| ip | INET | YES |  |
| expires_at | TIMESTAMPTZ | NO |  |
| revoked_at | TIMESTAMPTZ | YES |  |

Indexes: INDEX(user_id); INDEX(expires_at)

#### audit_logs

Append-only record of mutations and sensitive reads.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| actor_id | UUID | YES | FK → users(id); NULL for system |
| branch_id | UUID | YES | Scope context |
| action | TEXT | NO | e.g., patient.update |
| target_type | TEXT | NO | Entity type |
| target_id | UUID | YES | Entity id |
| payload | JSONB | YES | Diff/context (no secrets) |
| ip | INET | YES |  |
| created_at | TIMESTAMPTZ | NO | Partition key |

Indexes: INDEX(tenant_id, created_at); INDEX(actor_id); INDEX(target_type, target_id) — PARTITION BY RANGE(created_at)

### 8.5.4 Patient

#### patients

Master patient record; one MRN per tenant, shared across branches.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| mrn | TEXT | NO | Medical record number; UNIQUE per tenant |
| first_name | TEXT | NO |  |
| middle_name | TEXT | YES |  |
| last_name | TEXT | NO |  |
| gender | TEXT (enum) | NO | male \| female \| other \| unknown |
| dob | DATE | NO |  |
| national_id | TEXT | YES | UNIQUE per tenant when present |
| passport_no | TEXT | YES |  |
| phone | TEXT | YES | Indexed for search |
| email | TEXT | YES |  |
| address | JSONB | YES | Structured address |
| emergency_contact | JSONB | YES | Name, relation, phone |
| blood_group | TEXT | YES |  |

Indexes: UNIQUE(tenant_id, mrn); INDEX(tenant_id, phone); INDEX(tenant_id, national_id); GIN trigram on name for fuzzy search

#### guardian_links

Links a minor/dependent patient to a guardian.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) (dependent) |
| guardian_patient_id | UUID | YES | FK → patients(id) if guardian is also a patient |
| guardian_user_id | UUID | YES | FK → users(id) / portal user |
| relationship | TEXT | NO | e.g., mother, father |

Indexes: INDEX(patient_id)

#### patient_insurance

Patient's insurance policies.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) |
| provider_id | UUID | NO | FK → insurance_providers(id) |
| coverage_plan_id | UUID | YES | FK → coverage_plans(id) |
| policy_no | TEXT | NO |  |
| valid_from | DATE | YES |  |
| valid_to | DATE | YES |  |
| is_primary | BOOLEAN | NO | default true |

Indexes: INDEX(patient_id); INDEX(provider_id)

#### allergies

Recorded patient allergies (safety-critical).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) |
| substance | TEXT | NO |  |
| reaction | TEXT | YES |  |
| severity | TEXT (enum) | NO | mild \| moderate \| severe |

Indexes: INDEX(patient_id)

#### conditions

Chronic conditions and problem list entries.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) |
| icd_code | TEXT | YES |  |
| description | TEXT | NO |  |
| status | TEXT (enum) | NO | active \| resolved \| inactive |
| onset_date | DATE | YES |  |

Indexes: INDEX(patient_id)

#### attachments

Files attached to a patient (S3-backed).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) |
| encounter_id | UUID | YES | FK → encounters(id) if visit-linked |
| type | TEXT (enum) | NO | pdf \| image \| report \| scan |
| s3_key | TEXT | NO | Object storage key |
| filename | TEXT | NO |  |
| mime_type | TEXT | NO |  |
| size_bytes | BIGINT | NO |  |

Indexes: INDEX(patient_id); INDEX(encounter_id)

### 8.5.5 Scheduling

#### slots

Bookable availability for a provider/resource.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | NO | FK → branches(id) |
| provider_id | UUID | YES | FK → users(id) |
| resource_id | UUID | YES | FK → resources(id) |
| starts_at | TIMESTAMPTZ | NO |  |
| ends_at | TIMESTAMPTZ | NO |  |
| status | TEXT (enum) | NO | open \| held \| booked \| blocked |

Indexes: INDEX(branch_id, starts_at); INDEX(provider_id, starts_at)

#### appointments

A scheduled patient visit.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | NO | FK → branches(id) |
| department_id | UUID | YES | FK → departments(id) |
| patient_id | UUID | NO | FK → patients(id) |
| provider_id | UUID | YES | FK → users(id) |
| slot_id | UUID | YES | FK → slots(id) |
| starts_at | TIMESTAMPTZ | NO |  |
| status | TEXT (enum) | NO | booked \| confirmed \| checked_in \| completed \| cancelled \| no_show |
| reason | TEXT | YES | Chief complaint / cancel reason |
| source | TEXT (enum) | NO | staff \| portal |

Indexes: INDEX(branch_id, starts_at); INDEX(patient_id); INDEX(provider_id, starts_at); INDEX(status)

#### queue_entries

Live queue position within a department.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | NO | FK → branches(id) |
| department_id | UUID | NO | FK → departments(id) |
| patient_id | UUID | NO | FK → patients(id) |
| appointment_id | UUID | YES | FK → appointments(id) |
| state | TEXT (enum) | NO | waiting \| called \| in_consult \| done \| no_show |
| priority | INTEGER | NO | default 0; higher = triaged first |
| enqueued_at | TIMESTAMPTZ | NO |  |

Indexes: INDEX(department_id, state, priority, enqueued_at)

### 8.5.6 Clinical / EMR

#### encounters

A consultation episode tying EMR data together.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) |
| branch_id | UUID | NO | FK → branches(id) |
| department_id | UUID | YES | FK → departments(id) |
| provider_id | UUID | NO | FK → users(id) |
| appointment_id | UUID | YES | FK → appointments(id) |
| status | TEXT (enum) | NO | open \| closed |
| started_at | TIMESTAMPTZ | NO |  |
| closed_at | TIMESTAMPTZ | YES |  |

Indexes: INDEX(patient_id, started_at); INDEX(provider_id); INDEX(status)

#### clinical_notes

SOAP / progress notes (immutable once signed).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | NO | FK → encounters(id) |
| type | TEXT (enum) | NO | soap \| progress \| nursing |
| content | JSONB | NO | Structured note (S/O/A/P sections) |
| signed_by | UUID | YES | FK → users(id) |
| signed_at | TIMESTAMPTZ | YES | NULL = draft |
| amends_note_id | UUID | YES | FK → clinical_notes(id) for amendments |

Indexes: INDEX(encounter_id)

#### vitals

Vital sign measurements.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | NO | FK → encounters(id) |
| type | TEXT (enum) | NO | bp \| hr \| temp \| spo2 \| weight \| height \| bmi \| … |
| value_num | NUMERIC(10,2) | YES | Numeric value |
| value_text | TEXT | YES | e.g., 120/80 for BP |
| unit | TEXT | NO |  |
| taken_at | TIMESTAMPTZ | NO |  |

Indexes: INDEX(encounter_id); INDEX(type, taken_at)

#### diagnoses

ICD-coded diagnoses on an encounter.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | NO | FK → encounters(id) |
| icd_code | TEXT | NO |  |
| description | TEXT | NO |  |
| is_primary | BOOLEAN | NO | default false |

Indexes: INDEX(encounter_id); INDEX(icd_code)

#### procedures

Procedures performed/recorded on an encounter.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | NO | FK → encounters(id) |
| code | TEXT | YES | Procedure/service code |
| description | TEXT | NO |  |
| performed_at | TIMESTAMPTZ | YES |  |
| data | JSONB | YES | Specialty detail (e.g., per-tooth) |

Indexes: INDEX(encounter_id)

#### referrals

Referrals out of or within the clinic.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | NO | FK → encounters(id) |
| to_department_id | UUID | YES | FK → departments(id) |
| external_to | TEXT | YES | External provider |
| reason | TEXT | NO |  |

Indexes: INDEX(encounter_id)

#### follow_ups

Scheduled follow-up instructions.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | NO | FK → encounters(id) |
| due_date | DATE | YES |  |
| instructions | TEXT | YES |  |
| appointment_id | UUID | YES | FK → appointments(id) once booked |

Indexes: INDEX(encounter_id)

#### prescriptions

A prescription issued during an encounter.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | NO | FK → encounters(id) |
| patient_id | UUID | NO | FK → patients(id) |
| status | TEXT (enum) | NO | draft \| signed \| dispensed \| cancelled |
| signed_by | UUID | YES | FK → users(id) |
| signed_at | TIMESTAMPTZ | YES |  |

Indexes: INDEX(encounter_id); INDEX(patient_id)

#### prescription_items

Line items of a prescription.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| prescription_id | UUID | NO | FK → prescriptions(id) |
| drug_id | UUID | YES | FK → drugs(id) (null for free-text) |
| drug_text | TEXT | YES | Free-text drug name |
| dose | TEXT | NO |  |
| route | TEXT | YES |  |
| frequency | TEXT | NO |  |
| duration | TEXT | NO |  |
| instructions | TEXT | YES |  |

Indexes: INDEX(prescription_id)

### 8.5.7 Forms

#### form_templates

A named, specialty-oriented form definition.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO |  |
| specialty | TEXT | YES |  |
| category | TEXT | YES | intake \| exam \| consent \| … |
| current_version_id | UUID | YES | FK → form_versions(id) |
| is_active | BOOLEAN | NO | default true |

Indexes: INDEX(tenant_id)

#### form_versions

Immutable versioned JSON schema of a template.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| template_id | UUID | NO | FK → form_templates(id) |
| version | INTEGER | NO | Monotonic per template |
| schema_json | JSONB | NO | Field definitions, validation, conditions |
| role_restrictions | JSONB | YES | Allowed roles to complete |
| published_at | TIMESTAMPTZ | YES |  |

Indexes: UNIQUE(template_id, version)

#### form_submissions

Captured form data bound to a schema version.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| form_version_id | UUID | NO | FK → form_versions(id) |
| encounter_id | UUID | YES | FK → encounters(id) |
| patient_id | UUID | YES | FK → patients(id) |
| data_json | JSONB | NO | Submitted values |
| submitted_by | UUID | YES | FK → users(id) |

Indexes: INDEX(encounter_id); INDEX(patient_id); GIN(data_json)

### 8.5.8 Laboratory

#### lab_test_groups

Panels/groupings of tests.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO |  |
| code | TEXT | YES | UNIQUE per tenant |

Indexes: INDEX(tenant_id)

#### lab_tests

Test catalog with specimen and reference ranges.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| group_id | UUID | YES | FK → lab_test_groups(id) |
| code | TEXT | NO | UNIQUE per tenant |
| name | TEXT | NO |  |
| specimen | TEXT | YES | e.g., blood, urine |
| unit | TEXT | YES |  |
| reference_range | JSONB | YES | Age/sex-aware ranges |
| price | NUMERIC(12,2) | YES |  |

Indexes: UNIQUE(tenant_id, code); INDEX(group_id)

#### lab_orders

An order for one or more tests from an encounter.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| encounter_id | UUID | YES | FK → encounters(id) |
| patient_id | UUID | NO | FK → patients(id) |
| branch_id | UUID | NO | FK → branches(id) |
| ordered_by | UUID | NO | FK → users(id) |
| status | TEXT (enum) | NO | ordered \| collected \| in_process \| resulted \| cancelled |

Indexes: INDEX(patient_id); INDEX(branch_id, status)

#### lab_order_items

Tests within an order.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| order_id | UUID | NO | FK → lab_orders(id) |
| test_id | UUID | NO | FK → lab_tests(id) |

Indexes: INDEX(order_id)

#### lab_samples

Specimen collected for an order item.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| order_id | UUID | NO | FK → lab_orders(id) |
| test_id | UUID | NO | FK → lab_tests(id) |
| barcode | TEXT | NO | Tracking id; UNIQUE per tenant |
| status | TEXT (enum) | NO | pending \| collected \| received \| in_process \| resulted |
| collected_at | TIMESTAMPTZ | YES |  |

Indexes: UNIQUE(tenant_id, barcode); INDEX(order_id)

#### lab_results

Result values with validation/approval lifecycle.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| sample_id | UUID | NO | FK → lab_samples(id) |
| value_num | NUMERIC(14,4) | YES |  |
| value_text | TEXT | YES |  |
| unit | TEXT | YES |  |
| flag | TEXT (enum) | YES | normal \| high \| low \| critical |
| state | TEXT (enum) | NO | entered \| validated \| approved |
| entered_by | UUID | YES | FK → users(id) |
| validated_by | UUID | YES | FK → users(id) |
| approved_by | UUID | YES | FK → users(id) |
| source | TEXT (enum) | NO | manual \| csv \| device |

Indexes: INDEX(sample_id); INDEX(state)

### 8.5.9 Pharmacy

#### drugs

Drug catalog.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO |  |
| generic_name | TEXT | YES |  |
| classification | TEXT | YES | ATC/therapeutic class |
| form | TEXT | YES | tablet \| syrup \| injection \| … |
| strength | TEXT | YES |  |
| unit | TEXT | YES |  |
| is_controlled | BOOLEAN | NO | default false |

Indexes: INDEX(tenant_id); trigram on name

#### drug_batches

Stock by batch with expiry (branch-scoped).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| drug_id | UUID | NO | FK → drugs(id) |
| branch_id | UUID | NO | FK → branches(id) |
| batch_no | TEXT | NO |  |
| expiry_date | DATE | NO |  |
| qty_on_hand | NUMERIC(14,2) | NO | default 0 |
| cost_price | NUMERIC(12,2) | YES |  |
| sale_price | NUMERIC(12,2) | YES |  |

Indexes: INDEX(drug_id, branch_id); INDEX(expiry_date)

#### suppliers

Pharmacy/inventory suppliers.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO |  |
| contact | JSONB | YES |  |

Indexes: INDEX(tenant_id)

#### purchase_orders

Orders to suppliers (pharmacy + inventory).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| supplier_id | UUID | NO | FK → suppliers(id) |
| branch_id | UUID | NO | FK → branches(id) |
| status | TEXT (enum) | NO | draft \| sent \| received \| cancelled |
| total | NUMERIC(14,2) | YES |  |

Indexes: INDEX(supplier_id); INDEX(branch_id, status)

#### po_items

Lines of a purchase order.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| po_id | UUID | NO | FK → purchase_orders(id) |
| drug_id | UUID | YES | FK → drugs(id) |
| item_id | UUID | YES | FK → inventory_items(id) |
| qty | NUMERIC(14,2) | NO |  |
| unit_cost | NUMERIC(12,2) | YES |  |

Indexes: INDEX(po_id)

#### goods_receipts

Receipt of goods against a PO.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| po_id | UUID | NO | FK → purchase_orders(id) |
| received_by | UUID | NO | FK → users(id) |
| received_at | TIMESTAMPTZ | NO |  |
| notes | TEXT | YES |  |

Indexes: INDEX(po_id)

#### dispenses

A dispensing transaction (against Rx or OTC).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| prescription_id | UUID | YES | FK → prescriptions(id) (null for OTC) |
| branch_id | UUID | NO | FK → branches(id) |
| patient_id | UUID | YES | FK → patients(id) |
| dispensed_by | UUID | NO | FK → users(id) |
| dispensed_at | TIMESTAMPTZ | NO |  |

Indexes: INDEX(prescription_id); INDEX(branch_id)

#### dispense_items

Items dispensed from specific batches.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| dispense_id | UUID | NO | FK → dispenses(id) |
| batch_id | UUID | NO | FK → drug_batches(id) |
| qty | NUMERIC(14,2) | NO |  |
| unit_price | NUMERIC(12,2) | YES |  |

Indexes: INDEX(dispense_id)

#### otc_sales

Over-the-counter sales (no prescription).

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| dispense_id | UUID | NO | FK → dispenses(id) |
| invoice_id | UUID | YES | FK → invoices(id) |

Indexes: INDEX(dispense_id)

### 8.5.10 Inventory

#### inventory_items

Non-drug consumables/supplies.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO |  |
| sku | TEXT | YES | UNIQUE per tenant |
| uom | TEXT | NO | Unit of measure |
| reorder_level | NUMERIC(14,2) | YES |  |

Indexes: UNIQUE(tenant_id, sku)

#### stock_levels

On-hand quantity per item per branch.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| item_id | UUID | NO | FK → inventory_items(id) |
| branch_id | UUID | NO | FK → branches(id) |
| on_hand | NUMERIC(14,2) | NO | default 0 |

Indexes: UNIQUE(item_id, branch_id)

#### stock_transfers

Inter-branch stock movement.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| item_id | UUID | NO | FK → inventory_items(id) |
| from_branch_id | UUID | NO | FK → branches(id) |
| to_branch_id | UUID | NO | FK → branches(id) |
| qty | NUMERIC(14,2) | NO |  |
| status | TEXT (enum) | NO | requested \| dispatched \| received \| cancelled |

Indexes: INDEX(item_id); INDEX(from_branch_id); INDEX(to_branch_id)

#### purchase_requests

Branch requests for procurement.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | NO | FK → branches(id) |
| item_id | UUID | YES | FK → inventory_items(id) |
| drug_id | UUID | YES | FK → drugs(id) |
| qty | NUMERIC(14,2) | NO |  |
| status | TEXT (enum) | NO | open \| approved \| ordered \| closed |

Indexes: INDEX(branch_id, status)

#### stock_counts

Physical count / audit events with variance.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | NO | FK → branches(id) |
| item_id | UUID | YES | FK → inventory_items(id) |
| batch_id | UUID | YES | FK → drug_batches(id) |
| counted_qty | NUMERIC(14,2) | NO |  |
| system_qty | NUMERIC(14,2) | NO |  |
| variance | NUMERIC(14,2) | NO | counted − system |
| counted_by | UUID | NO | FK → users(id) |

Indexes: INDEX(branch_id)

### 8.5.11 Finance

#### charges

A billable item generated by a service event.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) |
| encounter_id | UUID | YES | FK → encounters(id) |
| branch_id | UUID | NO | FK → branches(id) |
| source | TEXT (enum) | NO | consultation \| lab \| pharmacy \| procedure \| package |
| source_ref | UUID | YES | Id of originating record |
| description | TEXT | NO |  |
| amount | NUMERIC(12,2) | NO |  |
| status | TEXT (enum) | NO | pending \| invoiced \| void |

Indexes: INDEX(patient_id); INDEX(encounter_id); INDEX(branch_id, status)

#### invoices

Aggregated bill for a patient/visit.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| patient_id | UUID | NO | FK → patients(id) |
| branch_id | UUID | NO | FK → branches(id) |
| number | TEXT | NO | Human-readable; UNIQUE per tenant |
| status | TEXT (enum) | NO | draft \| issued \| partially_paid \| paid \| void |
| subtotal | NUMERIC(14,2) | NO |  |
| discount_total | NUMERIC(14,2) | NO | default 0 |
| tax_total | NUMERIC(14,2) | NO | default 0 |
| total | NUMERIC(14,2) | NO |  |
| issued_at | TIMESTAMPTZ | YES |  |

Indexes: UNIQUE(tenant_id, number); INDEX(patient_id); INDEX(branch_id, status)

#### invoice_lines

Line items linking charges to an invoice.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| invoice_id | UUID | NO | FK → invoices(id) |
| charge_id | UUID | YES | FK → charges(id) |
| description | TEXT | NO |  |
| qty | NUMERIC(12,2) | NO | default 1 |
| unit_price | NUMERIC(12,2) | NO |  |
| amount | NUMERIC(14,2) | NO |  |

Indexes: INDEX(invoice_id)

#### payments

Payments applied to an invoice.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| invoice_id | UUID | NO | FK → invoices(id) |
| method | TEXT (enum) | NO | cash \| card \| gateway \| insurance |
| amount | NUMERIC(14,2) | NO |  |
| reference | TEXT | YES | Gateway/txn reference |
| received_by | UUID | YES | FK → users(id) |
| received_at | TIMESTAMPTZ | NO |  |

Indexes: INDEX(invoice_id)

#### refunds

Refunds against a payment.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| payment_id | UUID | NO | FK → payments(id) |
| amount | NUMERIC(14,2) | NO |  |
| reason | TEXT | NO |  |
| refunded_by | UUID | NO | FK → users(id) |

Indexes: INDEX(payment_id)

#### price_lists

Service pricing per branch.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| branch_id | UUID | YES | NULL = tenant default |
| service_code | TEXT | NO |  |
| description | TEXT | YES |  |
| price | NUMERIC(12,2) | NO |  |

Indexes: UNIQUE(tenant_id, branch_id, service_code)

#### discounts

Discount definitions and applications.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| code | TEXT | YES |  |
| type | TEXT (enum) | NO | percent \| fixed |
| value | NUMERIC(12,2) | NO |  |
| requires_approval | BOOLEAN | NO | default true |

Indexes: INDEX(tenant_id)

### 8.5.12 Insurance

#### insurance_providers

Payers/insurers.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| name | TEXT | NO |  |
| contact | JSONB | YES |  |

Indexes: INDEX(tenant_id)

#### coverage_plans

Plans offered by a provider.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| provider_id | UUID | NO | FK → insurance_providers(id) |
| name | TEXT | NO |  |
| copay_rule | JSONB | YES | Co-pay/coverage rules |
| covered_services | JSONB | YES | Service coverage map |

Indexes: INDEX(provider_id)

#### claims

Insurance claim for an invoice.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| invoice_id | UUID | NO | FK → invoices(id) |
| coverage_plan_id | UUID | NO | FK → coverage_plans(id) |
| status | TEXT (enum) | NO | prepared \| submitted \| approved \| rejected \| reimbursed |
| amount | NUMERIC(14,2) | NO | Claimed amount |
| submitted_at | TIMESTAMPTZ | YES |  |

Indexes: INDEX(invoice_id); INDEX(coverage_plan_id); INDEX(status)

#### claim_items

Claimed line items.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| claim_id | UUID | NO | FK → claims(id) |
| invoice_line_id | UUID | NO | FK → invoice_lines(id) |
| covered_amount | NUMERIC(14,2) | NO |  |

Indexes: INDEX(claim_id)

#### reimbursements

Payments received from insurers.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| claim_id | UUID | NO | FK → claims(id) |
| amount | NUMERIC(14,2) | NO |  |
| reference | TEXT | YES |  |
| received_at | TIMESTAMPTZ | NO |  |

Indexes: INDEX(claim_id)

### 8.5.13 Platform Services

#### notifications

Outbound notification records and delivery status.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| channel | TEXT (enum) | NO | email \| sms \| in_app \| push |
| recipient | TEXT | NO | Address/number/user id |
| template | TEXT | NO | Template key |
| payload | JSONB | YES | Template variables |
| status | TEXT (enum) | NO | queued \| sent \| failed |
| attempts | INTEGER | NO | default 0 |
| sent_at | TIMESTAMPTZ | YES |  |

Indexes: INDEX(tenant_id, status); INDEX(channel)

#### reports

Generated report artifacts.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| type | TEXT | NO | Report key |
| params | JSONB | YES | Filters used |
| status | TEXT (enum) | NO | queued \| ready \| failed |
| s3_key | TEXT | YES | Generated file |
| requested_by | UUID | NO | FK → users(id) |

Indexes: INDEX(tenant_id, type)

#### settings

Key/value settings at tenant/branch/user scope.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| scope | TEXT (enum) | NO | tenant \| branch \| user |
| scope_id | UUID | YES | branch_id or user_id when applicable |
| key | TEXT | NO |  |
| value | JSONB | NO |  |

Indexes: UNIQUE(tenant_id, scope, scope_id, key)

#### event_outbox

Transactional outbox for reliable event publishing.

| Column | Type | Null | Constraints & Notes |
| --- | --- | --- | --- |
| aggregate_type | TEXT | NO | e.g., encounter |
| aggregate_id | UUID | NO |  |
| event_type | TEXT | NO | Routing key |
| payload | JSONB | NO | Event body |
| sequence | BIGSERIAL | NO | Per-aggregate ordering |
| dispatched_at | TIMESTAMPTZ | YES | NULL = pending |

Indexes: INDEX(dispatched_at); INDEX(aggregate_type, aggregate_id)

## 8.6 Relationships & Referential Integrity

- All foreign keys are explicit with ON DELETE RESTRICT by default; soft delete is used instead of cascading hard deletes for clinical/financial data.

- Tenant-owned foreign keys reference rows within the same tenant; the repository layer guarantees same-tenant joins.

- One-to-many: tenant→branches→departments; patient→encounters; encounter→notes/vitals/diagnoses/prescriptions; order→samples→results.

- Many-to-many resolved via join tables: roles↔permissions (role_permissions), users↔roles-with-scope (user_role_scopes).

## 8.7 Indexing Strategy

- Every tenant-owned table is indexed on tenant_id (often as a composite prefix, e.g., (tenant_id, created_at)).

- All foreign keys are indexed to support joins and cascade checks.

- Search: GIN trigram indexes on patient name and drug name; OpenSearch is the primary full-text/search surface, kept in sync via the indexer worker.

- Hot lookups: composite indexes match query predicates (e.g., queue_entries(department_id, state, priority, enqueued_at); appointments(branch_id, starts_at)).

- Partial indexes on deleted_at IS NULL keep active-row scans cheap.

## 8.8 Partitioning Strategy

| Table | Partitioning | Rationale |
| --- | --- | --- |
| audit_logs | RANGE by created_at (monthly) | High write volume; time-based retention/pruning |
| notifications | RANGE by created_at (monthly) | High churn; old rows archivable |
| event_outbox | RANGE by created_at (weekly) or pruned | Short-lived rows; fast dispatch scans |
| encounters / vitals / lab_results | By tenant (hash) at scale; optional time sub-partition | Spread very large tenants; bound index size |

Table 8.3 — Partitioning applied to the highest-volume tables; introduced as data volume warrants (Phase B/C).

## 8.9 Tenant Isolation Strategy

- Mandatory tenant_id on every tenant-owned table; the tenancy context injects it into every query parameter set.

- Repository layer is the single choke point: queries are generated to always include the tenant predicate, so omission is not possible in application code.

- Optional PostgreSQL Row-Level Security: policies keyed on a session GUC (app.tenant_id) provide database-level defence in depth.

- Connection pooling sets the tenant GUC per transaction when RLS is enabled.

## 8.10 Soft Delete Strategy

- Clinical and financial tables use deleted_at; queries filter deleted_at IS NULL via the repository layer.

- Reference/lookup data may use an is_active flag instead where history is unnecessary.

- Hard deletion is reserved for purge operations under the data-retention policy (e.g., post-cancellation grace expiry).

## 8.11 Audit Strategy

- Every mutation publishes an audit event; the audit consumer writes append-only rows to audit_logs (no updates/deletes).

- Audit captures actor, tenant, branch, action, target, payload diff, IP, and timestamp (FR-AUD-01/02).

- Sensitive reads (e.g., viewing a patient's record) are also audited where required for compliance.

- Tamper evidence: rows are immutable; optional hash-chaining links each entry to the previous for the tenant.

## 8.12 Migration Strategy

- Schema changes are versioned, reversible migrations (e.g., goose/atlas) checked into the repository and run in CI/CD before deploy.

- Migrations are backward-compatible (expand/contract): add columns and backfill before switching reads, drop later, so rolling deploys never break.

- SQLC regenerates typed query code from the updated schema; a CI check fails the build if generated code is stale.

- Large backfills run as background jobs in batches to avoid long locks.