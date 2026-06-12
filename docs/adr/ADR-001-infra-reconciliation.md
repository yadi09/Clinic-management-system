# ADR-001: MVP Infrastructure Reconciliation (Blueprint vs Override)

**Status:** Accepted · **Date:** 2026-06-11 · **Decision owner:** Lead Architect

**Context:** The Part 1/2/4 blueprints mandate a heavy cloud-native stack (K8s, RabbitMQ, Redis, OpenSearch, S3, Prometheus/Grafana/Loki/OTel, microservice-extractable monolith). The authoritative INFRASTRUCTURE OVERRIDE supersedes that for MVP: single Oracle Cloud Free VPS, Docker Compose, Postgres-native search, Cloudinary behind a storage abstraction, Redis/RabbitMQ only-if-justified, modular monolith, no K8s/OpenSearch/microservices. **Product scope is unchanged** — only the infra realization and timing change. The guiding rule: *keep every future seam, implement only today's need.*

---

## Conflict 1 — Orchestration: Kubernetes → Docker Compose
- **Blueprint:** K8s with HPA on CPU/latency (API) and queue depth (workers); stateful operators for PG/Redis/RabbitMQ/OpenSearch (Part 2 §5.8).
- **MVP decision:** Single VPS, **Docker Compose** with three compose files (`compose.dev.yml`, `compose.staging.yml`, `compose.prod.yml` layered via a base `compose.yml`). Caddy as TLS-terminating reverse proxy (auto Let's Encrypt) in front of the Go `api` container. One `worker` container (scheduler/cron + future consumers). Postgres as a container with a bind-mounted volume + nightly `pg_dump` to Cloudinary/object storage.
- **Justification:** Oracle Free tier (ARM Ampere, ~24GB RAM/4 OCPU) runs a monolith + Postgres + Caddy comfortably. K8s control-plane overhead is pure cost with zero MVP benefit and slows time-to-market.
- **Seam preserved:** Containers are 12-factor (config from env, stateless API, no local session/file state). The Dockerfile produces an image that runs identically under K8s later. NFR-24 (cloud-agnostic container) is satisfied; only the orchestrator deferred. The compose service graph maps 1:1 to future Deployments.

## Conflict 2 — Async messaging: RabbitMQ + transactional outbox → Postgres outbox + in-process dispatcher (RabbitMQ DEFERRED)
- **Blueprint:** RabbitMQ topic exchange per env, routing key `<module>.<aggregate>.<event>`, publisher confirms, DLQ, at-least-once with idempotent consumers (Part 2 §5.5, §7.8).
- **MVP decision:** Keep the **transactional outbox table (`event_outbox`) exactly as specified in the schema** — this is the load-bearing seam and costs nothing to build now. Replace the broker with an **in-process synchronous dispatcher for the request path** plus a **polling relay in the `worker` container that reads `event_outbox` and invokes registered handlers** (notifications send, audit write, search index refresh, charge creation). Handlers are idempotent keyed on `event_id`. No RabbitMQ in MVP.
- **Justification:** At Phase A volume (~100 clinics, ~30k encounters/day → low single-digit events/sec) Postgres-as-queue (`SELECT ... FOR UPDATE SKIP LOCKED`) is more than sufficient, removes an entire stateful service, and eliminates dual-write inconsistency without a broker. RabbitMQ earns its place only when (a) fan-out to many independent consumers is needed, or (b) a module is extracted to a microservice.
- **Seam preserved:** The `EventBus` interface (`Publish(ctx, event)`) and `EventHandler` interface are identical whether backed by in-process relay or RabbitMQ. Routing keys (`<module>.<aggregate>.<event>`) are stored on outbox rows from day one. Swapping the relay's "invoke handler" for "publish to RabbitMQ" is a single adapter change, no domain/service code touched. **RabbitMQ trigger condition (documented for Phase 5–9):** sustained outbox lag > 30s, or first microservice extraction.

## Conflict 3 — Caching/sessions/rate-limit: Redis → in-process + Postgres (Redis DEFERRED, justified add at Phase 2)
- **Blueprint:** Redis for caching, sessions, and per-tenant/per-IP token-bucket rate limiting (Part 2 §5.2, §7.7 middleware order 4).
- **MVP decision:** **No Redis in Phase 0–1.** Sessions are stateless (JWT access in memory + refresh-token hash row in `sessions` table — already in schema; rotation/revocation are DB ops). Rate limiting starts as **in-process token bucket** (single API instance, so a per-process limiter is globally accurate). Caching: rely on Postgres + TanStack Query client-side cache; no server cache needed at MVP read volumes.
- **Justification:** With one API container there is no cross-instance state to share, which is Redis's whole reason for existing here. Adding it now is premature optimization.
- **Redis add trigger (Phase 2, justified):** The **live Queue board (FR-QUE-02, NFR-04: state propagation < 2s)** is the first genuine Redis justification — for pub/sub fan-out to SSE/WebSocket connections and for a shared rate-limiter once the API scales to >1 instance. **Decision: introduce Redis in Phase 2 ONLY IF** we run >1 API replica or queue polling proves insufficient; otherwise serve queue updates via **SSE backed by Postgres LISTEN/NOTIFY** (no new service). Seam: a `Cache` interface and `RateLimiter` interface are defined in `kernel` from day one with in-memory implementations.

## Conflict 4 — Search: OpenSearch → Postgres FTS + pg_trgm
- **Blueprint:** OpenSearch as *primary* full-text/search + analytics surface, kept in sync by an indexer worker; GIN trigram in Postgres treated as secondary (Part 2 §8.7).
- **MVP decision:** **Postgres is the only search surface.** Patient search (FR-PAT-04, NFR-03 p95 < 400ms) uses `pg_trgm` GIN indexes on name + a generated `tsvector` column for full-text, exactly as the schema's "GIN trigram on name" already anticipates. Drug-name search likewise.
- **Justification:** Trigram + FTS on a properly indexed, tenant-filtered table handles millions of rows under 400ms; OpenSearch is operational weight unjustified below Phase B.
- **Seam preserved:** All search lives behind a per-module `SearchPort` interface (`SearchPatients(ctx, tenantID, query, page)`), implemented by a `pg` adapter. The blueprint's `PatientRegistered`/`LabResultApproved` events that would feed the indexer are already emitted via the outbox — so adding an OpenSearch adapter later is: write a new event handler that indexes + a new `SearchPort` adapter, flip a config flag. No call sites change. **OpenSearch trigger:** Phase B/C scale or cross-entity/analytics search needs.

## Conflict 5 — Object storage: S3 + presigned URLs → Cloudinary behind StorageService interface
- **Blueprint:** S3-compatible storage, presigned direct uploads (`POST /files/presign` → `upload_url`), keys stored as `*_s3_key` columns (Part 4 §10.15, schema `attachments.s3_key` etc.).
- **MVP decision:** Define a **`StorageProvider` interface** in `kernel/storage` (`GenerateUploadURL(ctx, opts) (uploadURL, key)`, `GetURL(key)`, `Delete(key)`). Initial implementation = **Cloudinary** (signed upload params). **Rename schema columns from `s3_key` to `storage_key`** (provider-neutral) — the only schema deviation, and a beneficial one.
- **Justification:** Cloudinary has a generous free tier, handles image transforms (useful for dermatology lesion photos / signatures), and removes the need to run/secure MinIO on the VPS at MVP.
- **Seam preserved:** App code references `storage_key` opaque strings and the interface only. The blueprint's presign API contract (`POST /api/v1/files/presign` returning `upload_url` + `key`) is preserved verbatim — Cloudinary's signed upload fits the same shape. Future S3/MinIO/Spaces/B2 = new interface implementation + env config, zero app changes.

## Conflict 6 — Observability: Prometheus/Grafana/Loki/OTel → structured logs + /healthz + /metrics endpoint
- **Blueprint:** Full Prometheus + Grafana + Loki + OpenTelemetry stack; System Health screen links to Grafana (Part 2 §5.9, Part 3.1 §10.4).
- **MVP decision:** **Structured JSON logging to stdout** (captured by Docker, shipped nowhere fancy — `docker logs` + logrotate). Expose `/healthz` (liveness), `/readyz` (DB ping), and a `/metrics` Prometheus-format endpoint (cheap, no scraper required yet). Defer Grafana/Loki/OTel.
- **Justification:** A single VPS doesn't need a distributed tracing/log-aggregation pipeline; stdout + a metrics endpoint covers MVP ops.
- **Seam preserved:** `/metrics` already speaks Prometheus, so dropping in a Prometheus+Grafana container later is config-only. Request-ID/correlation-ID middleware (Part 2 §7.7 order 2) is kept so traces are reconstructable and OTel can wrap later. The "System Health" platform screen degrades gracefully to reading `/metrics` + DB stats directly until Grafana exists.

## Conflict 7 — Microservices/extraction → strict modular monolith now
- **Blueprint:** Modular monolith *with* documented strangler extraction order (Notifications → Lab → Pharmacy/Inventory → Reporting → Finance) (Part 2 §5.10).
- **MVP decision:** Build the **modular monolith with hard module boundaries enforced now** (one `api` binary + one `worker` binary). Do **not** extract anything.
- **Justification & seam:** This is the one area where blueprint and override fully agree. We bank the seam by enforcing §5.3 dependency rules in CI (import-linting: a module may import only `kernel` + other modules' `ports.go`, never another module's `repo`/`domain`/`http`). Each module's `ports.go` + outbox events are the extraction surface. No conflict — just discipline.

---

## Other blueprint/override tensions resolved
- **MFA at MVP:** Blueprint mandates TOTP MFA (FR-AUTH-03) and *mandatory* MFA for platform staff + privileged tenant roles. Override is silent. **Decision:** Build TOTP MFA in **Phase 0** (it is auth-foundation and cheap with a Go TOTP lib); enforce-by-policy in Phase 1. Not deferrable — it's a security baseline and a platform-staff requirement.
- **SSO (SAML/OIDC):** Blueprint says per-tenant SSO (Part 4 §10.5). **Decision: defer to Phase 10** (Advanced SaaS). The auth module's `IdentityProvider` seam allows adding OIDC later. Not MVP.
- **RLS:** Blueprint calls RLS "optional, defence-in-depth." Part 4 §10.3 implies RLS is the injection mechanism. **Decision (see multitenancy_decision): enable RLS from Phase 0** as the safety net behind repository predicates — it is cheap insurance for a medical-data SaaS and closes the cross-tenant-leak risk that is otherwise one forgotten `WHERE tenant_id` away.
- **Subdomain-per-tenant routing** (`{tenant}.clinicos.app`): Blueprint Part 4 §10.2. **Decision:** Support tenant resolution from subdomain at the Caddy layer, but for MVP a **wildcard DNS + single Caddy cert** keeps it one VPS. Tenant claim in JWT is cross-checked against host (per §10.3). Seam intact for later region routing.
- **Money representation conflict:** Part 2 schema says `NUMERIC(12,2)`; Part 4 API says integer-minor-unit + currency. **Decision:** Store `NUMERIC(12,2)` in Postgres (DB source of truth, exact decimal), serialize to API as `{amount: <minor int>, currency}` in the HTTP DTO layer. Both honored; conversion lives in finance module DTO mappers.
- **ID format conflict:** Part 2 says UUID v7 PKs; Part 4 says ULID opaque strings with prefixes (`pat_`, `enc_`). **Decision:** UUID v7 as DB PK (index-friendly, time-ordered). API surface exposes them as prefixed opaque strings via a thin codec in `kernel/httpx` (`pat_` + base32(uuid)). Internal = UUID, external = prefixed string. Both contracts satisfied.
