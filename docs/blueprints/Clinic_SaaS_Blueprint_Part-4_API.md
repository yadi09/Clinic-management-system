# Source: Clinic_SaaS_Blueprint_Part-4_API.docx

Clinic Management SaaS Platform

Implementation-Ready Blueprint

Part 4 — API Specification

| Document | Part 4: API Specification |
| --- | --- |
| Section | 10 (continues the core blueprint; follows Architecture & UI/UX) |
| API style | REST over HTTPS/JSON · versioned /api/v1 · OpenAPI 3.1 |
| Backend | Go / Gin modular monolith · SQLC / PostgreSQL · events via RabbitMQ |
| Covers | Conventions, auth, errors, pagination, idempotency, resource catalog, endpoints, webhooks, versioning, OpenAPI |
| Diagrams | Request lifecycle, auth flow, resource map, webhook delivery, end-to-end visit sequence |
| Status | Implementation-ready draft v3 |

# Contents

10. API Specification

10.1 Overview & Design Principles

10.2 Conventions

10.3 Multi-Tenancy & Scoping

10.4 Request Lifecycle

10.5 Authentication & Authorization

10.6 Standard Response Envelope

10.7 Error Model & Catalog

10.8 Common Headers

10.9 Pagination, Filtering & Sorting

10.10 Idempotency & Optimistic Concurrency

10.11 Rate Limiting & Quotas

10.12 Resource Catalog

10.13 Endpoint Reference (Selected)

10.14 Webhooks & Events

10.15 File Uploads & Bulk Operations

10.16 Versioning & Deprecation

10.17 OpenAPI, SDKs & Developer Experience

10.18 End-to-End Example: A Patient Visit

# 10. API Specification

A versioned, resource-oriented REST API over HTTPS/JSON, served by the Go/Gin modular monolith. Every request is authenticated, tenant- and branch-scoped, authorised by RBAC and feature flags, and returned in a consistent envelope. The contract is published as OpenAPI 3.1 with generated SDKs.

## 10.1 Overview & Design Principles

- Resource-oriented REST. Nouns as plural resources, HTTP verbs for actions, predictable URLs; non-CRUD operations modelled as sub-resources or explicit actions (e.g., POST /appointments/{id}/cancel).

- Consistent & predictable. One response envelope, one error model, one pagination scheme, snake_case JSON fields, ISO-8601 UTC timestamps, and ULID identifiers everywhere.

- Secure & multi-tenant by construction. Tenant and branch scope are derived server-side from the token and context, never trusted from the client body; cross-tenant access is impossible (Sections 5.7, 8.9).

- Safe to retry. Mutations accept an Idempotency-Key; concurrent updates use ETag/If-Match optimistic concurrency.

- Evolvable. URI-versioned (/api/v1), additive changes only within a version, with a published deprecation policy.

- Contract-first. OpenAPI 3.1 is the source of truth; server validation, docs, and client SDKs derive from it.

## 10.2 Conventions

All endpoints are rooted at the versioned base path. Collections are plural; a resource is addressed by its identifier; relationships nest one level where it aids clarity.

| Base URL      https://{tenant}.clinicos.app/api/v1 Platform URL  https://admin.clinicos.app/api/v1        (platform-tier endpoints)  GET    /api/v1/patients                 list / search patients POST   /api/v1/patients                 create a patient GET    /api/v1/patients/{id}            retrieve a patient PATCH  /api/v1/patients/{id}            partial update DELETE /api/v1/patients/{id}            soft-delete (archive) POST   /api/v1/appointments/{id}/cancel  action on a resource |
| --- |

#### Data formats

- Encoding. application/json (UTF-8) for requests and responses; multipart only for direct uploads.

- Field naming. snake_case keys; enums are lower_snake strings; money is an integer minor unit plus a currency code (e.g., {"amount": 4750, "currency": "USD"}).

- Identifiers. ULIDs as opaque strings (e.g., pat_01J9Z3K8...); never sequential integers in the API surface.

- Timestamps. ISO-8601 in UTC with a trailing Z; clients localise using the branch/user timezone.

#### HTTP status codes

| Code | Meaning | When |
| --- | --- | --- |
| 200 OK | Success | GET, PATCH, action returning a body |
| 201 Created | Resource created | POST creating a resource (Location header set) |
| 202 Accepted | Async accepted | Long-running/queued work (e.g., bulk export) |
| 204 No Content | Success, no body | DELETE, some actions |
| 400 Bad Request | Malformed/invalid | Validation failure (see error model) |
| 401 Unauthorized | Not authenticated | Missing/expired/invalid token |
| 403 Forbidden | Not authorised | RBAC/scope/feature-flag denies |
| 404 Not Found | No such resource (in scope) | Unknown id or out-of-scope |
| 409 Conflict | State conflict | Duplicate, version mismatch (If-Match) |
| 422 Unprocessable | Semantic error | Valid shape, business rule fails |
| 429 Too Many Requests | Rate limited | Quota exceeded (Retry-After set) |
| 5xx | Server error | Unexpected; safe to retry idempotent calls |

Table 10.1 — Status codes used by the API.

## 10.3 Multi-Tenancy & Scoping

The tenant is resolved from the request host (subdomain) and cross-checked against the token’s tenant claim; a mismatch is rejected. The active branch comes from the X-Branch-ID header (or the user’s default) and is validated against the user’s assigned scope. Both are injected into the data layer (row-level security), so queries are constrained regardless of any client input.

- List endpoints return only in-scope records; out-of-scope ids return 404 (not 403) to avoid leaking existence.

- Platform-tier endpoints (tenants, plans, billing) live on the admin host and require a platform role; they never expose tenant clinical data.

## 10.4 Request Lifecycle

Every call passes through a fixed pipeline: transport and gateway controls, authentication, tenant/branch resolution, authorisation, then the typed handler, service, and data layer — emitting domain events transactionally where state changes.

Figure 10.1 — API request lifecycle.

## 10.5 Authentication & Authorization

Authentication uses OAuth2-style password and refresh-token grants issuing short-lived JWT access tokens and rotating refresh tokens; SSO (SAML/OIDC) is supported per tenant. Authorisation is enforced server-side from the token’s role and scope claims plus the tenant’s feature flags. MFA is required for platform staff and privileged tenant roles.

Figure 10.2 — Authentication & token flow.

#### Token endpoints

| Method & path | Purpose |
| --- | --- |
| POST /auth/login | Exchange credentials for tokens (may return mfa_required) |
| POST /auth/mfa | Complete MFA challenge, return tokens |
| POST /auth/refresh | Rotate refresh token, issue new access token |
| POST /auth/logout | Revoke the current session/refresh token |
| GET /auth/sso/{provider} | Begin SSO; callback issues tokens |
| GET /auth/me | Current identity, role, scope, enabled flags |

Table 10.2 — Authentication endpoints.

#### Example — login

| POST /api/v1/auth/login            Host: downtown-clinic.clinicos.app Content-Type: application/json  { "email": "dr.chen@downtown-clinic.com", "password": "••••••••" }  200 OK { "data": { "access_token": "eyJhbGciOi...",      // JWT, expires in 900s "refresh_token": "rt_01J9...",         // rotating, httpOnly cookie option "token_type": "Bearer", "expires_in": 900, "user": { "id": "usr_01J9...", "role": "doctor", "branch_scope": ["br_01"], "mfa": true } } } |
| --- |

Subsequent requests send Authorization: Bearer <access_token>. The access token carries tenant_id, role, scope and feature flags; the server re-validates them on every call (it never trusts client-supplied scope).

#### Authorization model

- Scopes / permissions. Fine-grained permissions (e.g., encounter.sign, billing.invoice) map to roles; the matrix lives in the PRD and is enforced centrally as middleware.

- Service accounts & API keys. Server-to-server integrations use scoped API keys (Authorization: Bearer sk_...) bound to a tenant and permission set; platform integrations use platform keys.

## 10.6 Standard Response Envelope

Single resources return under data; collections add a paginated meta block. This uniformity lets clients and SDKs handle every endpoint identically.

| // single resource { "data": { "id": "pat_01J9...", "first_name": "Aisha", ... } }  // collection { "data": [ { "id": "pat_01J9...", ... }, { "id": "pat_01JA...", ... } ], "meta": { "pagination": { "limit": 25, "next_cursor": "eyJpZCI6...", "prev_cursor": null, "total": 312 } } } |
| --- |

## 10.7 Error Model & Catalog

Errors return a non-2xx status and a stable, machine-readable body: a top-level code, a human message, an optional details array (field-level), and the request id for support correlation.

| 422 Unprocessable Entity { "error": { "code": "validation_failed", "message": "One or more fields are invalid.", "request_id": "req_01J9Z...", "details": [ { "field": "phone", "code": "invalid_format", "message": "Enter a valid E.164 phone number." } ] } } |
| --- |

| Error code | HTTP | Meaning |
| --- | --- | --- |
| validation_failed | 400/422 | Request body/query failed validation |
| unauthenticated | 401 | Missing or invalid credentials/token |
| mfa_required | 401 | MFA challenge must be completed |
| forbidden | 403 | Role/scope/flag does not permit the action |
| not_found | 404 | Resource does not exist in the caller’s scope |
| conflict | 409 | Duplicate or unique-constraint violation |
| version_conflict | 409 | If-Match/ETag mismatch (stale update) |
| rule_violation | 422 | Business rule failed (e.g., allergy block) |
| rate_limited | 429 | Quota exceeded; see Retry-After |
| internal_error | 500 | Unexpected server error (correlate via request_id) |

Table 10.3 — Error catalog.

## 10.8 Common Headers

| Header | Direction | Purpose |
| --- | --- | --- |
| Authorization | request | Bearer access token or API key |
| X-Branch-ID | request | Active branch scope (defaults to user’s primary) |
| Idempotency-Key | request | Safe retries for POST (see 10.10) |
| If-Match | request | Optimistic concurrency (ETag of last read) |
| X-Request-ID | both | Client- or server-generated correlation id |
| ETag | response | Version tag of the returned resource |
| Location | response | URL of a newly created resource (201) |
| X-RateLimit-Remaining / Reset | response | Quota state |
| Retry-After | response | Seconds to wait after 429/503 |

Table 10.4 — Standard headers.

## 10.9 Pagination, Filtering & Sorting

Collections use cursor pagination by default (stable under inserts); offset pagination is available for small admin lists. Filtering uses explicit query parameters; sorting uses a signed field list; sparse fieldsets reduce payloads.

| GET /api/v1/patients?limit=25&cursor=eyJpZCI6...&sort=-created_at &filter[branch_id]=br_01&filter[status]=active&q=morgan &fields=id,first_name,last_name,mrn  // meta.pagination returns next_cursor / prev_cursor; follow next_cursor until null |
| --- |

## 10.10 Idempotency & Optimistic Concurrency

Unsafe operations that must not double-apply (payments, claim submission, dispensing) accept an Idempotency-Key; the server stores the first result and replays it for retries within a retention window. Updates use ETag/If-Match to reject stale writes.

| POST /api/v1/billing/payments Idempotency-Key: 9f1c2e6a-...        // client-generated UUID, reused on retry { "invoice_id": "inv_01J9...", "amount": 2750, "currency": "USD", "method": "card" }  PATCH /api/v1/patients/{id} If-Match: "W/etag-7"               // 409 version_conflict if changed since read |
| --- |

## 10.11 Rate Limiting & Quotas

Limits are applied per token and per tenant, scaled by plan. Responses expose remaining quota; 429s include Retry-After. Bulk and reporting endpoints have separate, lower limits.

| Plan | Sustained (req/min) | Burst | Webhooks/min |
| --- | --- | --- | --- |
| Starter | 300 | 60 | 60 |
| Professional | 1,200 | 200 | 240 |
| Business | 3,000 | 500 | 600 |
| Enterprise | Custom (SLA) | Custom | Custom |

Table 10.5 — Indicative rate limits by plan.

## 10.12 Resource Catalog

The API surface grouped by module. Flag-gated modules (laboratory, pharmacy, inventory, insurance, hr) return 403 feature_disabled when the tenant has not enabled them.

Figure 10.3 — Resource taxonomy (/api/v1).

#### Scheduling & front office

| Method & path | Description |
| --- | --- |
| GET/POST /appointments | List/search; book |
| GET/PATCH /appointments/{id} | Retrieve; update |
| POST /appointments/{id}/cancel \| /reschedule | Lifecycle actions |
| GET /scheduling/availability | Open slots by provider/resource/date |
| GET /scheduling/queue | Live queue board |
| POST /scheduling/queue/checkins | Check a patient in |
| POST /scheduling/queue/{id}/call \| /no-show | Queue actions |

Table 10.6 — Scheduling endpoints.

#### Clinical

| Method & path | Description |
| --- | --- |
| GET/POST /clinical/encounters | List; start an encounter |
| GET/PATCH /clinical/encounters/{id} | Retrieve; update (until signed) |
| POST /clinical/encounters/{id}/sign | Sign & lock the note |
| POST /clinical/encounters/{id}/vitals | Record vitals |
| POST /clinical/encounters/{id}/diagnoses | Add ICD-10 diagnosis |
| POST /clinical/encounters/{id}/prescriptions | Prescribe (allergy/interaction checked) |
| POST /clinical/encounters/{id}/lab-orders | Order investigations (flag: laboratory) |
| GET /clinical/patients/{id}/history | Timeline of encounters/results |

Table 10.7 — Clinical endpoints.

#### Billing & finance

| Method & path | Description |
| --- | --- |
| GET/POST /billing/invoices | List; assemble an invoice from charges |
| POST /billing/invoices/{id}/issue \| /void | Lifecycle |
| POST /billing/payments | Record a payment (idempotent) |
| POST /billing/refunds | Refund (approval-gated) |
| GET/POST /billing/claims | List; submit insurance claim (flag: insurance) |
| POST /billing/claims/{id}/resubmit | Resubmit a rejected claim |
| GET /billing/price-lists | Service pricing & discount rules |

Table 10.8 — Billing endpoints.

#### Admin & platform

| Method & path | Description |
| --- | --- |
| GET/POST/PATCH /admin/branches \| /departments | Org structure (tenant) |
| GET/POST/PATCH /admin/users \| /roles | Accounts & access (tenant) |
| GET/PATCH /admin/feature-flags | Enable modules within plan |
| GET /admin/audit | Tenant audit log |
| GET/POST/PATCH /platform/tenants | Provision & manage tenants (platform) |
| GET/PATCH /platform/plans \| /subscriptions | Commercial config (platform) |
| POST /platform/tenants/{id}/impersonations | Consented support session (platform) |

Table 10.9 — Admin & platform endpoints.

## 10.13 Endpoint Reference (Selected)

### 10.13.1 Create patient

| POST /api/v1/patients { "first_name": "Aisha", "last_name": "Morgan", "dob": "1991-04-12", "sex": "female", "phone": "+15550142", "branch_id": "br_01" }  201 Created    Location: /api/v1/patients/pat_01J9Z3K8... { "data": { "id": "pat_01J9Z3K8...", "mrn": "100245", "status": "active", "created_at": "2026-06-11T09:02:14Z" } }  // duplicate suspicion does not block; returns a warning collection: GET /api/v1/patients/duplicates?dob=1991-04-12&last_name=Morgan |
| --- |

### 10.13.2 Availability & booking

| GET /api/v1/scheduling/availability?provider_id=usr_01&date=2026-06-11 200 { "data": [ { "start": "2026-06-11T09:00:00Z", "duration_min": 20 }, ... ] }  POST /api/v1/appointments { "patient_id": "pat_01J9...", "provider_id": "usr_01", "start": "2026-06-11T09:00:00Z", "duration_min": 20, "reason": "follow_up" } 201 { "data": { "id": "apt_01JA...", "status": "booked" } } |
| --- |

### 10.13.3 Prescribe (clinical-safety enforced)

| POST /api/v1/clinical/encounters/enc_01J9.../prescriptions { "items": [ { "drug_id": "drg_amox500", "dose": "1 cap", "frequency": "tid", "duration_days": 7 } ] }  422 Unprocessable Entity { "error": { "code": "rule_violation", "message": "Prescription blocked by allergy check.", "details": [ { "code": "allergy_conflict", "drug_id": "drg_amox500", "message": "Patient is allergic to penicillin." } ] } } |
| --- |

### 10.13.4 Record a payment (idempotent)

| POST /api/v1/billing/payments Idempotency-Key: 9f1c2e6a-7b40-4e1e-9b2a-... { "invoice_id": "inv_01J9...", "amount": 2750, "currency": "USD", "method": "card", "reference": "TXN-55821" } 201 { "data": { "id": "pay_01JB...", "status": "recorded", "invoice": { "id": "inv_01J9...", "balance": 0 } } } |
| --- |

## 10.14 Webhooks & Events

Tenants and integrations subscribe to domain events. Events are emitted through a transactional outbox (no lost or duplicated state), delivered over HTTPS, signed with an HMAC-SHA256 signature, retried with exponential backoff, and dead-lettered after exhaustion.

Figure 10.4 — Webhook & event delivery.

#### Event catalog (selection)

| Event | Emitted when |
| --- | --- |
| patient.created | A patient record is created |
| appointment.booked / .cancelled | Appointment lifecycle |
| queue.checked_in | Patient checked in |
| encounter.started / .signed | Consultation lifecycle |
| prescription.created | A prescription is signed |
| lab.result.released | A validated lab result is released |
| charge.created | A billable charge accrues |
| invoice.issued | An invoice is issued |
| payment.recorded | A payment is captured |
| claim.submitted / .reimbursed | Insurance claim lifecycle |

Table 10.10 — Representative domain events.

#### Delivery & verification

| POST {subscriber_url}                         // from ClinicOS to your endpoint X-ClinicOS-Event: payment.recorded X-ClinicOS-Delivery: dlv_01JB... X-ClinicOS-Signature: t=1718096534,v1=5d41402abc...   // HMAC-SHA256(secret, t + body)  { "id": "evt_01JB...", "type": "payment.recorded", "created_at": "...Z", "tenant_id": "ten_01", "data": { "payment_id": "pay_01JB...", "invoice_id": "inv_01J9...", "amount": 2750, "currency": "USD" } }  // Respond 2xx to ack. Verify v1 against your signing secret; reject stale t. |
| --- |

## 10.15 File Uploads & Bulk Operations

- Uploads. Clients request a short-lived presigned URL, upload directly to object storage, then attach the returned key — large binaries never transit the API.

| POST /api/v1/files/presign   { "purpose": "attachment", "content_type": "image/png" } 200  { "data": { "upload_url": "https://s3...", "key": "att_01JB...", "expires_in": 300 } } // PUT bytes to upload_url, then reference key on the target resource. |
| --- |

- Bulk / async. Large exports and imports return 202 with a job id; clients poll GET /jobs/{id} or receive a job.completed webhook.

## 10.16 Versioning & Deprecation

- URI versioning (/api/v1). Within a version only additive, backward-compatible changes are made (new endpoints, optional fields).

- Breaking changes ship under a new major version; the prior version is supported for a published window (minimum 12 months).

- Deprecations are announced in changelog and surfaced via a Deprecation and Sunset header on affected responses.

## 10.17 OpenAPI, SDKs & Developer Experience

- Contract. The full OpenAPI 3.1 document is served at /api/v1/openapi.json and rendered as interactive docs; server request validation is generated from it.

- SDKs. Typed clients (TypeScript, Go, Python) are generated from the spec and versioned with the API.

- Sandbox. A per-tenant sandbox environment with seed data and test payment/gateway modes supports integration before go-live.

| # OpenAPI excerpt (paths/components elided) openapi: 3.1.0 info: { title: ClinicOS API, version: "1.0" } paths: /patients: post: operationId: createPatient security: [ { bearerAuth: [ patients.write ] } ] requestBody: { $ref: '#/components/requestBodies/PatientCreate' } responses: { '201': { $ref: '#/components/responses/Patient' } } |
| --- |

## 10.18 End-to-End Example: A Patient Visit

The endpoints above compose into the core visit journey. Synchronous calls drive the workflow; domain events (dashed) keep billing, notifications, and integrations in sync, and the lab result returns asynchronously via webhook.

Figure 10.5 — End-to-end visit: API call sequence.