# ClinicOS API Specification — Part 4 Digest (Section 10)

Source: `Clinic_SaaS_Blueprint_Part-4_API.docx` · Status: Implementation-ready draft v3 · Section 10 (follows Architecture & UI/UX). Cross-references: Sections 5.7, 8.9 (multi-tenancy/RLS), PRD (permission matrix).

## Stack & Top-Level Facts

| Aspect | Value |
|---|---|
| API style | REST over HTTPS/JSON, versioned `/api/v1`, OpenAPI 3.1 |
| Backend | Go / Gin modular monolith |
| Data layer | SQLC / PostgreSQL |
| Events | RabbitMQ (domain events emitted transactionally via outbox) |
| Object storage | S3 (presigned direct uploads — large binaries never transit the API) |
| Contract | OpenAPI 3.1 served at `/api/v1/openapi.json`; source of truth for server validation, docs, SDKs |
| Identifiers | ULIDs as opaque strings (e.g., `pat_01J9Z3K8...`); never sequential integers in the API surface |
| Timestamps | ISO-8601 UTC, trailing `Z`; clients localize via branch/user timezone |
| JSON convention | snake_case keys; enums are lower_snake strings |
| Money | integer minor unit + currency code, e.g., `{"amount": 4750, "currency": "USD"}` |

### Stack component usage (exact locations)
- **RabbitMQ** — domain events emitted transactionally where state changes (10.4 Request Lifecycle; 10.14 Webhooks via transactional outbox so "no lost or duplicated state").
- **S3 (object storage)** — file uploads (10.15): `POST /api/v1/files/presign` returns `upload_url` (`https://s3...`), client PUTs bytes directly, then references returned `key`.
- **PostgreSQL / SQLC** — data layer; tenant + branch injected into data layer via **row-level security (RLS)** so queries are constrained regardless of client input (10.3).
- No explicit mention of Redis, OpenSearch, or Kubernetes in this part.

## 10.1 Design Principles
- Resource-oriented REST; plural nouns; HTTP verbs for actions; non-CRUD modeled as sub-resources or explicit actions (e.g., `POST /appointments/{id}/cancel`).
- One response envelope, one error model, one pagination scheme.
- Tenant + branch scope derived server-side from token/context, **never trusted from client body**; cross-tenant access impossible.
- Mutations accept `Idempotency-Key`; concurrent updates use ETag/`If-Match`.
- URI-versioned `/api/v1`; additive-only within a version; published deprecation policy.
- Contract-first: OpenAPI 3.1 is source of truth.

## 10.2 Conventions — Base URLs

| URL | Purpose |
|---|---|
| `https://{tenant}.clinicos.app/api/v1` | Tenant base URL (subdomain = tenant) |
| `https://admin.clinicos.app/api/v1` | Platform-tier endpoints (admin host) |

Canonical CRUD pattern (patients example):
- `GET /api/v1/patients` — list/search
- `POST /api/v1/patients` — create
- `GET /api/v1/patients/{id}` — retrieve
- `PATCH /api/v1/patients/{id}` — partial update
- `DELETE /api/v1/patients/{id}` — soft-delete (archive)
- `POST /api/v1/appointments/{id}/cancel` — action on a resource

Data formats: `application/json` UTF-8 for request/response; `multipart` only for direct uploads.

### HTTP status codes (Table 10.1)

| Code | Meaning | When |
|---|---|---|
| 200 OK | Success | GET, PATCH, action returning body |
| 201 Created | Resource created | POST creating a resource (Location header set) |
| 202 Accepted | Async accepted | Long-running/queued work (e.g., bulk export) |
| 204 No Content | Success, no body | DELETE, some actions |
| 400 Bad Request | Malformed/invalid | Validation failure |
| 401 Unauthorized | Not authenticated | Missing/expired/invalid token |
| 403 Forbidden | Not authorised | RBAC/scope/feature-flag denies |
| 404 Not Found | No such resource (in scope) | Unknown id or out-of-scope |
| 409 Conflict | State conflict | Duplicate, version mismatch (If-Match) |
| 422 Unprocessable | Semantic error | Valid shape, business rule fails |
| 429 Too Many Requests | Rate limited | Quota exceeded (Retry-After set) |
| 5xx | Server error | Unexpected; safe to retry idempotent calls |

## 10.3 Multi-Tenancy & Scoping
- Tenant resolved from request **host (subdomain)** and cross-checked against token's `tenant_id` claim; **mismatch is rejected**.
- Active branch from **`X-Branch-ID` header** (or user's default), validated against user's assigned scope.
- Both injected into data layer (RLS) — queries constrained regardless of client input.
- List endpoints return only in-scope records; **out-of-scope ids return 404 (not 403)** to avoid leaking existence.
- Platform-tier endpoints (tenants, plans, billing) live on admin host, require a platform role, never expose tenant clinical data.

## 10.4 Request Lifecycle
Fixed pipeline per call: transport/gateway controls → authentication → tenant/branch resolution → authorisation → typed handler → service → data layer; emits domain events transactionally on state change. (Figure 10.1)

## 10.5 Authentication & Authorization
- OAuth2-style **password** and **refresh-token** grants; short-lived **JWT access tokens** + **rotating refresh tokens**.
- **SSO (SAML/OIDC)** supported per tenant.
- Authorisation enforced server-side from token's **role** + **scope** claims plus tenant **feature flags**.
- **MFA required for platform staff and privileged tenant roles.**
- Access token expiry: **900s** (`expires_in: 900`).

### Token endpoints (Table 10.2)

| Method & path | Purpose |
|---|---|
| `POST /auth/login` | Exchange credentials for tokens (may return `mfa_required`) |
| `POST /auth/mfa` | Complete MFA challenge, return tokens |
| `POST /auth/refresh` | Rotate refresh token, issue new access token |
| `POST /auth/logout` | Revoke current session/refresh token |
| `GET /auth/sso/{provider}` | Begin SSO; callback issues tokens |
| `GET /auth/me` | Current identity, role, scope, enabled flags |

### Login response shape (example)
`POST /api/v1/auth/login` → 200:
```
{ "data": { "access_token": "<JWT>", "refresh_token": "rt_01J9...", "token_type": "Bearer",
  "expires_in": 900, "user": { "id": "usr_01J9...", "role": "doctor", "branch_scope": ["br_01"], "mfa": true } } }
```
- Refresh token: rotating, with httpOnly cookie option.
- Subsequent requests: `Authorization: Bearer <access_token>`.
- Access token carries `tenant_id`, `role`, `scope`, feature flags; **server re-validates on every call; never trusts client-supplied scope.**

### Authorization model
- Fine-grained permissions/scopes map to roles, e.g., `encounter.sign`, `billing.invoice`, `patients.write` (OpenAPI excerpt). Matrix lives in PRD, enforced centrally as middleware.
- **Service accounts / API keys**: server-to-server use scoped API keys `Authorization: Bearer sk_...` bound to a tenant + permission set; platform integrations use platform keys.
- Role example seen: `doctor`.

## 10.6 Standard Response Envelope
- Single resource: `{ "data": { ... } }`.
- Collection: `{ "data": [ ... ], "meta": { "pagination": { "limit": 25, "next_cursor": "...", "prev_cursor": null, "total": 312 } } }`.

## 10.7 Error Model & Catalog
Body shape: `{ "error": { "code", "message", "request_id", "details": [ { "field", "code", "message" } ] } }`.

### Error catalog (Table 10.3)

| Error code | HTTP | Meaning |
|---|---|---|
| `validation_failed` | 400/422 | Request body/query failed validation |
| `unauthenticated` | 401 | Missing or invalid credentials/token |
| `mfa_required` | 401 | MFA challenge must be completed |
| `forbidden` | 403 | Role/scope/flag does not permit the action |
| `not_found` | 404 | Resource does not exist in caller's scope |
| `conflict` | 409 | Duplicate or unique-constraint violation |
| `version_conflict` | 409 | If-Match/ETag mismatch (stale update) |
| `rule_violation` | 422 | Business rule failed (e.g., allergy block) |
| `rate_limited` | 429 | Quota exceeded; see Retry-After |
| `internal_error` | 500 | Unexpected server error (correlate via request_id) |
| `feature_disabled` | 403 | (10.12) Flag-gated module not enabled by tenant |

## 10.8 Common Headers (Table 10.4)

| Header | Direction | Purpose |
|---|---|---|
| `Authorization` | request | Bearer access token or API key |
| `X-Branch-ID` | request | Active branch scope (defaults to user's primary) |
| `Idempotency-Key` | request | Safe retries for POST (10.10) |
| `If-Match` | request | Optimistic concurrency (ETag of last read) |
| `X-Request-ID` | both | Client- or server-generated correlation id |
| `ETag` | response | Version tag of returned resource |
| `Location` | response | URL of newly created resource (201) |
| `X-RateLimit-Remaining` / `Reset` | response | Quota state |
| `Retry-After` | response | Seconds to wait after 429/503 |
| `Deprecation` / `Sunset` | response | (10.16) On deprecated endpoints |

## 10.9 Pagination, Filtering & Sorting
- **Cursor pagination by default** (stable under inserts); offset pagination available for small admin lists.
- Filtering via explicit query params: `filter[field]=value`.
- Sorting via signed field list: `sort=-created_at` (`-` = descending).
- Sparse fieldsets: `fields=id,first_name,last_name,mrn`.
- Full-text/search via `q=` param.
- Example: `GET /api/v1/patients?limit=25&cursor=eyJpZCI6...&sort=-created_at&filter[branch_id]=br_01&filter[status]=active&q=morgan&fields=id,first_name,last_name,mrn`.
- Follow `meta.pagination.next_cursor` until `null`.

## 10.10 Idempotency & Optimistic Concurrency
- Unsafe non-idempotent operations (**payments, claim submission, dispensing**) accept `Idempotency-Key`; server stores first result and replays it for retries within a retention window.
- `Idempotency-Key` = client-generated UUID, reused on retry.
- Updates use `ETag`/`If-Match`; stale write → **409 `version_conflict`**. Example `If-Match: "W/etag-7"`.

## 10.11 Rate Limiting & Quotas (Table 10.5)
Limits per token and per tenant, scaled by plan. 429 includes `Retry-After`. Bulk/reporting endpoints have separate, lower limits.

| Plan | Sustained (req/min) | Burst | Webhooks/min |
|---|---|---|---|
| Starter | 300 | 60 | 60 |
| Professional | 1,200 | 200 | 240 |
| Business | 3,000 | 500 | 600 |
| Enterprise | Custom (SLA) | Custom | Custom |

## 10.12 Resource Catalog
Grouped by module. **Flag-gated modules** (laboratory, pharmacy, inventory, insurance, hr) return **403 `feature_disabled`** when tenant has not enabled them. (Figure 10.3)

### Scheduling & front office (Table 10.6)
| Method & path | Description |
|---|---|
| `GET/POST /appointments` | List/search; book |
| `GET/PATCH /appointments/{id}` | Retrieve; update |
| `POST /appointments/{id}/cancel` \| `/reschedule` | Lifecycle actions |
| `GET /scheduling/availability` | Open slots by provider/resource/date |
| `GET /scheduling/queue` | Live queue board |
| `POST /scheduling/queue/checkins` | Check a patient in |
| `POST /scheduling/queue/{id}/call` \| `/no-show` | Queue actions |

### Clinical (Table 10.7)
| Method & path | Description |
|---|---|
| `GET/POST /clinical/encounters` | List; start an encounter |
| `GET/PATCH /clinical/encounters/{id}` | Retrieve; update (until signed) |
| `POST /clinical/encounters/{id}/sign` | Sign & lock the note |
| `POST /clinical/encounters/{id}/vitals` | Record vitals |
| `POST /clinical/encounters/{id}/diagnoses` | Add ICD-10 diagnosis |
| `POST /clinical/encounters/{id}/prescriptions` | Prescribe (allergy/interaction checked) |
| `POST /clinical/encounters/{id}/lab-orders` | Order investigations (flag: laboratory) |
| `GET /clinical/patients/{id}/history` | Timeline of encounters/results |

### Billing & finance (Table 10.8)
| Method & path | Description |
|---|---|
| `GET/POST /billing/invoices` | List; assemble invoice from charges |
| `POST /billing/invoices/{id}/issue` \| `/void` | Lifecycle |
| `POST /billing/payments` | Record a payment (idempotent) |
| `POST /billing/refunds` | Refund (approval-gated) |
| `GET/POST /billing/claims` | List; submit insurance claim (flag: insurance) |
| `POST /billing/claims/{id}/resubmit` | Resubmit a rejected claim |
| `GET /billing/price-lists` | Service pricing & discount rules |

### Admin & platform (Table 10.9)
| Method & path | Description |
|---|---|
| `GET/POST/PATCH /admin/branches` \| `/departments` | Org structure (tenant) |
| `GET/POST/PATCH /admin/users` \| `/roles` | Accounts & access (tenant) |
| `GET/PATCH /admin/feature-flags` | Enable modules within plan |
| `GET /admin/audit` | Tenant audit log |
| `GET/POST/PATCH /platform/tenants` | Provision & manage tenants (platform) |
| `GET/PATCH /platform/plans` \| `/subscriptions` | Commercial config (platform) |
| `POST /platform/tenants/{id}/impersonations` | Consented support session (platform) |

## 10.13 Endpoint Reference (Selected, with shapes)

### 10.13.1 Create patient
`POST /api/v1/patients`
Request fields: `first_name`, `last_name`, `dob` (e.g., `1991-04-12`), `sex` (e.g., `female`), `phone` (E.164, e.g., `+15550142`), `branch_id`.
→ 201, `Location: /api/v1/patients/pat_01J9Z3K8...`
Response data: `id`, `mrn` (e.g., `100245`), `status: "active"`, `created_at`.
- Duplicate suspicion **does not block**; returns a warning collection via `GET /api/v1/patients/duplicates?dob=1991-04-12&last_name=Morgan`.

### 10.13.2 Availability & booking
- `GET /api/v1/scheduling/availability?provider_id=usr_01&date=2026-06-11` → 200, data array of `{ "start": "...Z", "duration_min": 20 }`.
- `POST /api/v1/appointments` request: `patient_id`, `provider_id`, `start` (ISO-8601 Z), `duration_min`, `reason` (e.g., `follow_up`). → 201 `{ "data": { "id": "apt_01JA...", "status": "booked" } }`.

### 10.13.3 Prescribe (clinical-safety enforced)
`POST /api/v1/clinical/encounters/{enc_id}/prescriptions`
Request: `{ "items": [ { "drug_id": "drg_amox500", "dose": "1 cap", "frequency": "tid", "duration_days": 7 } ] }`.
Failure → **422 `rule_violation`**, detail code **`allergy_conflict`** with `drug_id` and message (e.g., "Patient is allergic to penicillin.").

### 10.13.4 Record a payment (idempotent)
`POST /api/v1/billing/payments` with `Idempotency-Key: <UUID>`.
Request: `invoice_id`, `amount` (e.g., 2750), `currency` (e.g., `USD`), `method` (e.g., `card`), `reference` (e.g., `TXN-55821`).
→ 201 `{ "data": { "id": "pay_01JB...", "status": "recorded", "invoice": { "id": "inv_01J9...", "balance": 0 } } }`.

## 10.14 Webhooks & Events
- Subscriptions to domain events for tenants/integrations.
- Emitted via **transactional outbox** (no lost/duplicated state), delivered over HTTPS, **signed HMAC-SHA256**, **retried with exponential backoff**, **dead-lettered after exhaustion**. (Figure 10.4)

### Event catalog (Table 10.10)
| Event | Emitted when |
|---|---|
| `patient.created` | Patient record created |
| `appointment.booked` / `.cancelled` | Appointment lifecycle |
| `queue.checked_in` | Patient checked in |
| `encounter.started` / `.signed` | Consultation lifecycle |
| `prescription.created` | A prescription is signed |
| `lab.result.released` | A validated lab result is released |
| `charge.created` | A billable charge accrues |
| `invoice.issued` | An invoice is issued |
| `payment.recorded` | A payment is captured |
| `claim.submitted` / `.reimbursed` | Insurance claim lifecycle |

### Delivery & verification
Outbound `POST {subscriber_url}` headers:
- `X-ClinicOS-Event` (e.g., `payment.recorded`)
- `X-ClinicOS-Delivery` (e.g., `dlv_01JB...`)
- `X-ClinicOS-Signature` format: `t=<unix_ts>,v1=<hmac>` where signature = **HMAC-SHA256(secret, t + body)**

Payload shape: `{ "id": "evt_01JB...", "type", "created_at", "tenant_id": "ten_01", "data": { ... } }`.
Subscriber must **respond 2xx to ack**, verify `v1` against signing secret, and **reject stale `t`**.

## 10.15 File Uploads & Bulk Operations
- **Presigned upload flow**: `POST /api/v1/files/presign` request `{ "purpose": "attachment", "content_type": "image/png" }` → 200 `{ "data": { "upload_url": "https://s3...", "key": "att_01JB...", "expires_in": 300 } }`. Client PUTs bytes to `upload_url`, then references `key` on target resource. Presign expiry: **300s**.
- **Bulk/async**: large exports/imports return **202** with a job id; clients poll `GET /jobs/{id}` or receive a `job.completed` webhook.

## 10.16 Versioning & Deprecation
- URI versioning `/api/v1`; within a version only **additive, backward-compatible** changes (new endpoints, optional fields).
- Breaking changes → new major version; prior version supported for a published window, **minimum 12 months**.
- Deprecations announced in changelog and surfaced via **`Deprecation`** and **`Sunset`** response headers.

## 10.17 OpenAPI, SDKs & Developer Experience
- Full OpenAPI 3.1 doc served at **`/api/v1/openapi.json`**, rendered as interactive docs; server request validation generated from it.
- **Generated typed SDKs: TypeScript, Go, Python**, versioned with the API.
- Per-tenant **sandbox** environment with seed data and test payment/gateway modes for pre-go-live integration.
- OpenAPI excerpt: `openapi: 3.1.0`, `info: { title: ClinicOS API, version: "1.0" }`; example path `/patients` `post` → `operationId: createPatient`, `security: [ { bearerAuth: [ patients.write ] } ]`, requestBody `$ref '#/components/requestBodies/PatientCreate'`, response `'201' $ref '#/components/responses/Patient'`.

## 10.18 End-to-End Patient Visit
Synchronous calls drive the workflow; domain events (dashed in Figure 10.5) keep billing, notifications, and integrations in sync; lab result returns asynchronously via webhook (`lab.result.released`).

## Cross-cutting state machines / lifecycles captured
- **Encounter**: started → (editable until signed) → signed & locked (`POST .../sign`); events `encounter.started`/`.signed`.
- **Appointment**: booked → cancelled / rescheduled; queue: checked_in → call / no-show.
- **Invoice**: assembled → issued → void; payment `recorded`; refund (approval-gated).
- **Claim**: submitted → reimbursed; rejected → resubmit.
- **Patient status**: `active` (DELETE = soft-delete/archive).

## ID prefixes observed
`pat_` patient · `usr_` user · `br_`/`br_01` branch · `apt_` appointment · `enc_` encounter · `drg_` drug · `inv_` invoice · `pay_` payment · `evt_` event · `dlv_` delivery · `att_` attachment/file key · `ten_` tenant · `rt_` refresh token · `sk_` service API key · `req_` request id.

## Enum values observed
- `sex`: `female`
- appointment `reason`: `follow_up`; `status`: `booked`
- payment `method`: `card`; `status`: `recorded`
- patient `status`: `active`
- `token_type`: `Bearer`
- prescription `frequency`: `tid`
- Flag-gated modules: `laboratory`, `pharmacy`, `inventory`, `insurance`, `hr`

## Notable gaps / not specified in this part
Permission/role matrix (lives in PRD); idempotency-key retention window duration (unspecified beyond "retention window"); refresh-token TTL (only access token = 900s given); no Redis/OpenSearch/Kubernetes references in this document part.