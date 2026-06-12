# Open Questions & Decisions Log

Living log of decisions that need a human (commercial, legal, market) and the project risks we are actively mitigating. None of these block **Phase 0** (auth/tenancy/RBAC foundation); each is tagged with the phase it must be resolved by.

## ✅ Resolved (2026-06-12)
- **Q1 — Target market: Ethiopia / East Africa.** Defaults: **ETB** currency, **`Africa/Addis_Ababa`** timezone, `en` locale (Amharic-ready/i18n), **ICD-10**, local SMS gateway (selected at Phase 2). Compliance: GDPR+HIPAA-inspired controls, conservative retention — refined for local law.
- **Q2 — PHI storage: Cloudinary**, behind the `StorageProvider` interface. PHI-suitability caveat noted; swappable to MinIO/S3 with no app changes.
- **Foundation defaults (confirmed):** goose migrations · **Postgres RLS ON from day 1** · **UUIDv7** internal PKs + **prefixed opaque string IDs** at the API · Docker Compose dev/staging/prod · **TOTP MFA in Phase 0**.

Remaining open items below (Q3–Q8) are unblocked for Phase 0.

## Decisions needed (by phase)

| # | Question | Needed by | Default if unanswered |
|---|---|---|---|
| Q1 | **Compliance regime / target market** (HIPAA-US vs GDPR-EU vs local e.g. Ethiopia/East Africa). Sets retention defaults (NFR-16/27/28), erasure workflow, and whether shared-DB + RLS isolation satisfies the regulator. | Phase 1 | Configurable per-tenant; GDPR+HIPAA-inspired baseline; conservative retention |
| Q2 | **PHI storage policy** — is Cloudinary acceptable for patient medical images/reports/scans (PHI), or should attachments use self-hosted MinIO/S3 from the start? (Same `StorageProvider` interface either way.) | Phase 1 | Cloudinary (per infra override), with a documented PHI caveat; swappable adapter |
| Q3 | **Email/SMS provider** for notifications + appointment reminders. | Phase 2 | Pluggable provider interface; pick at Phase 2 (e.g. Postmark/SES + Twilio or local SMS) |
| Q4 | **Domain & subdomain strategy** — is a wildcard domain (e.g. `*.app`) acquired? Single-cert wildcard TLS on one Caddy for MVP, or per-tenant custom domains at launch? | Phase 1 | Wildcard subdomain + workspace-slug login field; custom domains later |
| Q5 | **Oracle Free VPS shape** (ARM Ampere A1 4 OCPU / 24 GB vs older AMD micro). Determines headroom before Redis/replica/RabbitMQ are forced, and whether ARM-only base images are required. | Phase 0 deploy | Assume ARM Ampere A1; build multi-arch images |
| Q6 | **Payment gateway** for tenant-facing payments (Phase 7) and platform subscription billing (Phase 10) — Stripe vs local gateway. Affects idempotency/webhook design. | Phase 7 | Gateway interface; Stripe in sandbox for design |
| Q7 | **ICD code set** (ICD-10 vs ICD-11) and whether licensed drug/lab catalogue seeds are provided or must be sourced. | Phase 3 (ICD), Phase 4/5 (catalogs) | ICD-10 seed; minimal open drug/lab seed, tenant-extendable |
| Q8 | **Backup/DR expectation** — NFR-11 wants RPO ≤ 15 min / RTO ≤ 1 h, but a single VPS with nightly `pg_dump` gives RPO ~24 h. Relax for MVP, or require WAL archiving / streaming replica from day one? | Phase 0 deploy | Nightly `pg_dump` + WAL archiving to object storage; documented restore runbook; relaxed RPO for MVP |

## Active risks & mitigations

| Risk | Mitigation |
|---|---|
| Single-VPS SPOF undermines 99.9% uptime (NFR-08) and RPO/RTO (NFR-11) | WAL archiving to object storage + restore runbook; promote to replica/managed PG when a paying-tenant SLA demands it |
| RLS + connection-pooler GUC leakage (pgbouncer txn mode) | Set `app.tenant_id` via `SET LOCAL` inside every tx in `kernel/db.WithTx`; CI integration test for cross-tenant isolation |
| Forgotten tenant predicate → cross-tenant PHI leak (catastrophic) | SQLC required `tenant_id` param **+** RLS net **+** automated cross-tenant probe test (defence in depth) |
| Module-boundary erosion → big ball of mud, kills extraction | Import-boundary linter as a CI gate from Phase 0; cross-module only via `ports.go` or events |
| Outbox-as-queue lag / poison messages (no broker DLQ) | Relay uses `FOR UPDATE SKIP LOCKED` + attempt counter + dead-letter column; alert on `dispatched_at` lag; documented RabbitMQ trigger |
| Form-builder (FR-FRM) is a sub-product that can swallow Phase 3 | Ship field-types + versioning first, conditional logic later; timebox; advanced builder = Phase 4 maturity |
| Real-time queue (<2s, NFR-04) over SSE+LISTEN/NOTIFY may not survive multi-replica | Heartbeat + client backoff now; pre-approved Redis pub/sub promotion when >1 API replica |
| Cloudinary lock-in / PHI suitability | `StorageProvider` interface keeps app provider-neutral; validate Cloudinary PHI terms early (Q2), else swap to S3/MinIO before Phase 1 |
| Scope creep across 31 modules / ~126 screens | Strict vertical-slice phasing; flag-gated modules off by default; MUST/SHOULD/MAY triage per phase |
| Money/ID representation mismatch (Part 2 NUMERIC/UUIDv7 vs Part 4 minor-unit/ULID) | Single DTO mapping layer (NUMERIC↔minor-unit; UUID↔prefixed-string), round-trip tested. See [ADR-001](./adr/ADR-001-infra-reconciliation.md) conflicts 6–8 |
