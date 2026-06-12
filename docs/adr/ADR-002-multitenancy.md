# ADR-002: Multi-Tenancy Isolation Strategy

**Status:** Accepted · **Date:** 2026-06-11 · **Decision owner:** Lead Architect

## Multi-Tenancy Isolation Strategy — Recommendation

**Recommended for MVP (ONE option): Shared database + shared schema + mandatory `tenant_id` on every tenant-owned row, enforced by BOTH (a) repository-injected tenant predicates AND (b) PostgreSQL Row-Level Security (RLS) keyed on a per-transaction session GUC `app.tenant_id`.**

This is exactly the blueprint's chosen model (Part 2 §5.7, §8.9) — the override does not contradict it, and it is the only model that fits "launch fast on one VPS" while preserving the 100→1,000→10,000 scaling path (NFR-05).

### Why shared-schema (not schema-per-tenant, not db-per-tenant) for MVP

| Criterion | Shared schema + tenant_id (CHOSEN) | Schema-per-tenant | DB-per-tenant |
|---|---|---|---|
| Onboarding cost (NFR-18, <15min) | Row inserts only — instant | Run migrations per tenant (slow, error-prone) | Provision DB per tenant (heavy) |
| Migrations at scale | One migration, all tenants | N schemas × every migration | N databases × every migration |
| VPS resource fit | One connection pool, one PG | Connection/catalog bloat at 100s of schemas | Impossible on one Free-tier VPS |
| Cross-tenant analytics (FR-ANL-02 future) | Trivial (filter) | Hard (cross-schema union) | Very hard |
| Time-to-market | Fastest | Slower | Slowest |
| Isolation strength | Strong (predicate + RLS) | Stronger | Strongest |

Schema-per-tenant and db-per-tenant trade away onboarding speed, migration simplicity, and single-VPS feasibility — the exact MVP priorities — for isolation we can otherwise achieve with RLS. They are reserved for the *few* very large/regulated tenants later, not the base tier.

### How SQLC + tenant scoping + RLS coexist (the mechanism)

1. **Schema:** Every tenant-owned table has `tenant_id UUID NOT NULL` (per §8.2 standard columns), indexed (often as composite prefix e.g. `(tenant_id, created_at)`).
2. **SQLC queries always take `tenant_id` as `$1`.** Every `.sql` query in `repo/queries/` includes `WHERE tenant_id = $1 AND deleted_at IS NULL`. SQLC generates typed Go where `tenant_id` is a required parameter — a developer *cannot compile* a query that forgets the column. Example (verbatim from blueprint, kept):
   ```sql
   -- name: GetPatientByMRN :one
   SELECT * FROM patients WHERE tenant_id = $1 AND mrn = $2 AND deleted_at IS NULL;
   ```
3. **Tenancy context is the single source of `tenant_id`.** Middleware (`kernel/tenancy`) resolves tenant from the JWT `tenant_id` claim, cross-checks it against the request host/subdomain (Part 4 §10.3 — mismatch → reject), and puts it in `context.Context`. Repository wrappers read it from context and pass it as `$1` — callers never hand-type a tenant id, so it cannot be spoofed from a request body (§10.3 "never trusted from client").
4. **RLS is the defence-in-depth net.** `kernel/db` tx manager runs `SET LOCAL app.tenant_id = $tenantID` at the start of every transaction (pulled from the same context). RLS policies on every tenant-owned table: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. So even a hypothetical hand-written or buggy query physically cannot read another tenant's rows — Postgres rejects them. This directly satisfies NFR-13 (zero cross-scope access) and the FR/NFR acceptance test "Branch Manager on Branch A requests Branch B → denied + audited."
5. **Branch/department scoping** layers on top in the **service layer** (not RLS): the authorization guard checks the principal's `user_role_scopes` (branch_id/department_id) before the query runs. Tenant isolation = DB-enforced; branch/dept isolation = app-enforced (it's authorization, not isolation, and is more dynamic).
6. **Platform/global tables** (`plans`, `permissions`) carry no `tenant_id` and have no RLS — they're shared reference data. Platform-admin endpoints run on the admin host with a platform role and bypass tenant GUC.

### Migration path (when a tenant outgrows shared schema)
Because the tenant key is **uniform everywhere**, scaling is code-free:
- **Phase B (~1k clinics):** Partition hot tables (`audit_logs`, `notifications`, `event_outbox` by `created_at`; `encounters`/`vitals`/`lab_results` by tenant hash) per §8.8. No app change.
- **Phase B/C, large tenant:** Move that tenant's rows to a **dedicated schema or a dedicated Postgres cluster**; route by `tenant_id` at the data layer (connection selection in `kernel/db`). Same SQLC code, same RLS, same `tenant_id` parameter — only the connection target changes. This is the blueprint's "schema-per-tenant or dedicated cluster migration without code change" (§5.7 Table 5.3).
- **Future data residency:** tenant→region routing at the edge (Caddy/DNS) + region-pinned clusters; `tenants.region` column already exists.

**Net:** Start with the simplest model that is still medically safe (predicate + RLS), pay only row-insert onboarding cost, and keep an exit ramp to per-tenant isolation that touches connection routing only — never domain code.
