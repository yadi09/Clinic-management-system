# Verify.ET Integration — Blueprint & Agent Prompts

Prepared for Nick (ReiCB) · 22 Aug 2026
Source: `verify.et/docs/api`, `verify.et/docs/get-started`, `verify.et/pricing`, and the logged-in API Keys dashboard. **Every field, endpoint, status code and header in this document was read directly from those pages.** Nothing here is inferred or illustrative. Where the docs are silent, it says so explicitly.

---

## 1. What you are integrating

Verify.ET is a **transaction receipt verification** service for Ethiopian banks and mobile wallets. It does not move money, hold funds, or settle anything. You send it a payment reference that a customer has given you as proof of payment; it returns whether that transaction exists and its details.

**Supported providers and their required identifiers:**

| Bank key | Required fields |
|---|---|
| `cbe` | `referenceNumber`/`reference` + `accountSuffix`/`suffix` — exactly 8 digits |
| `boa` | `referenceNumber`/`reference` + `accountSuffix`/`suffix` — exactly 5 digits |
| `telebirr` | `transactionNumber` or `reference` |
| `mpesa` | `transactionNumber` or `reference`; receipt URLs and supported SMS text can be parsed |
| `cbebirr` | `receiptNumber`/`reference` + `phone`/`phoneNumber` |
| `dashen` | `referenceNumber` or `reference` |
| `awash` | `referenceNumber` or `reference` |
| `siinqee` | `referenceNumber` or `reference` |
| `kaafiebirr` | `referenceNumber`/`reference`; `phone` optional. Full receipt URLs auto-route; bare tokens require explicit `bank` |
| `zemen` | **Appears in status/bank enums but direct `POST /api/verify` submissions are NOT supported.** Returns unsupported. |

A "universal smart-router" mode exists: omit `bank`, send `reference` plus optional `suffix` and `phoneNumber`. An explicit `bank` always wins over router detection. `phoneNumber` accepts `09XXXXXXXX` or `251XXXXXXXXX` and normalises to `251XXXXXXXXX`.

---

## 2. The part that matters most: this is a fraud control, not a lookup

A naive integration reads `verified: true` and releases the order. That is defeatable two ways, and the API gives you a defence against each. **Both must be wired in or the integration is worse than useless — it launders a manual fraud check into an automated approval.**

### 2.1 `settlementAccountMatch` — was it paid to *you*?

A receipt can be completely genuine and still not be a payment to your account. This object confirms the receiver.

- Send `settlementAccount` in the request for a one-off receiver check, **or** omit it and Verify.ET falls back to the account's saved `/api/bank-accounts` records and registered business settlement accounts for that bank.
- Wallet-type banks (Telebirr, M-Pesa) match via Ethiopian phone canonicalisation; regular banks prefer normalised account-number matching.
- Masked provider values (`2519****0897`, `1****7441`) are matched on visible digits.

Response object fields: `matched`, `matchType`, `matchConfidence`, `source`, `bank`, `receiverAccount`, `matchedSettlementAccount`, `matchedUserBankAccountId`, `matchedBusinessBankAccountId`, `candidateCount`, `ambiguous`, `reason`, `debug`.

Stable `reason` codes:
`receiver_account_exact_match`, `receiver_mask_matches_visible_digits`, `receiver_suffix_matches`, `no_registered_accounts`, `missing_receiver_account`, `candidate_account_mismatch`, `ambiguous_registered_accounts`, `verification_not_successful`.

Observed `matchType` values: `masked_pattern`, `unmatched`. Observed `matchConfidence`: `high`, `none`.

Critically: **an ambiguous masked match returns `matched: false` with `ambiguous: true`** and a candidate count rather than silently picking one saved account. Your code must treat that as "needs human review", not as a failure and not as a pass.

### 2.2 `confirmationHistory` — has this receipt been claimed before?

This is your replay / double-spend guard. Fields: `scope` (observed value: `platform`), `isFirstConfirmation`, `confirmedBefore`, `firstConfirmedAt`, `lastConfirmedAt`, `confirmationCount`.

`scope: "platform"` means the count spans the whole Verify.ET platform, not just your account. So `confirmedBefore: true` does **not** automatically mean fraud in your system — it may have been confirmed by a different merchant, or by your own earlier retry. Your logic has to combine this with your own local record of which references you have already accepted. Getting this distinction wrong in either direction causes real damage: too strict and you reject legitimate customers, too loose and one receipt pays for many orders.

---

## 3. Auth, and the current state of your account

- Header: `x-api-key`. Key format prefix: `VERIFY_BANK_ET_`.
- Keys are permission-scoped. `POST /api/verify` needs `verification:write`; all read/poll/stream/history endpoints need `verification:read`. Metrics and reports need `metrics:read`; uptime needs `uptime:read`.
- `POST /api/api-keys` creates a key but authenticates with a **session cookie, not an API key** — so key creation is a dashboard action, not something your backend can bootstrap.
- The full secret is returned **once** at creation. Dashboard banner: "New API keys are shown once after creation. Store the full key in your server-side secret manager before closing the success dialog."
- Session cookies also work for dashboard-owned routes, but the docs direct server-to-server integrations to API keys with explicit permissions.

**Blocking, as of today:** your dashboard shows **no API keys created** and **"No active plan yet."** Credits are account-level and shared across dashboard, mobile and API usage. Nothing is callable until a key exists and a plan is active. I did not create a key — it is your credential and it is displayed only once.

---

## 4. Request/response contract

Base URL: `https://verify.et` — this is the only base URL documented. **There is no sandbox or staging environment.** The getting-started page states the examples "intentionally use the same base URL your production integration uses." The only test facility is `POST /api/verify/test-webhook`, which validates your callback endpoint.

**Endpoints:**

| Method | Path | Permission |
|---|---|---|
| POST | `/api/verify` | `verification:write` |
| GET | `/api/verify/:requestId` | `verification:read` |
| GET | `/api/verify/:requestId/events` (SSE) | `verification:read` |
| GET | `/api/verify/history` | `verification:read` |
| POST | `/api/verify/test-webhook` | `verification:read` |
| GET | `/api/metrics` | `metrics:read` |
| GET | `/api/reports/*` | `metrics:read` |
| GET | `/api/uptime`, `/overview`, `/v2/overview` | `uptime:read` |
| GET | `/api/uptime/client/*` | public |
| GET | `/api/credits/balance`, `/usage`, `/transactions`, `/packages` | (not stated on the reference page) |
| GET/POST/PATCH/DELETE | `/api/bank-accounts` | (not stated on the reference page) |
| GET | `/health/live`, `/health/ready`, `/metrics` (Prometheus) | — |

**Request headers:** `x-api-key`, `content-type: application/json`, `Idempotency-Key` (optional), `X-Webhook-Url` (optional). Query param `waitMs` on submit, capped by server and per-bank defaults.

**Response headers:** `x-request-id`, `X-Verify-Cache` (e.g. `HIT`), `Retry-After`.

**Envelope:** `success`, `message`, `data`. Verification submissions also return `requestId`, `verification`, and `links`.

- `POST /api/verify` returns **200** with the completed result, or **202** queued with `statusUrl`, `estimatedWaitMs`, and `links.pollAfterMs`.
- `verification` object: `requestId`, `bank`, `processingStatus`, `status`, `verified`.
- Observed `processingStatus` values: `queued`, `running`, `completed`, `failed`. Observed `status` values: `pending`, `success`.
- Completed result item fields: `bank`, `status`, `verified`, `amount`, `currency`, `senderName`, `receiverName`, `receiverAccount`, `referenceNumber`, `accountSuffix`, `timestamp`, `confirmationHistory`, `settlementAccountMatch`.

### Three shape traps in the published examples — flag these to whoever implements

1. **`data` changes type between endpoints.** On `POST /api/verify` it is an **array** (`"data": [ { ... } ]`). On `GET /api/verify/:requestId` it is an **object** (`"data": { ... }`). Code that assumes one shape will break on the other.
2. **`amount` changes type between transports.** The synchronous 200 example shows `"amount": 1500` (number). The webhook payload example shows `"amount": "1500"` (string). Parse defensively and use a decimal type — never a float — for money.
3. **`accountSuffix` is a digit string with meaning.** `"12345678"` must not be coerced to an integer anywhere in the pipeline, or leading zeros are destroyed.

---

## 5. Result delivery — four options, and the trade-off

| Option | Mechanism | When it fits |
|---|---|---|
| Short wait | `POST /api/verify?waitMs=5000` | Best-effort immediate answer at checkout. Server caps the wait per bank, so you must still handle the 202 fallback. |
| Polling | `GET /api/verify/:requestId` until `processingStatus` is `completed` or `failed`, respecting `links.pollAfterMs` | Your UI owns the waiting experience. |
| SSE | `GET /api/verify/:requestId/events`, `accept: text/event-stream`. Emits `status` events, closes with `done` (`reason`: `terminal` or `timeout`) | Near-real-time UI without polling load. |
| Webhook | `webhookUrl` in body or `X-Webhook-Url` header; worker POSTs `verification.completed` | Backend-owned terminal result. Most reliable for order state. |

**Recommendation:** webhook as the source of truth for order state, plus a polling reconciler as fallback, plus optional `waitMs` purely to make the happy path feel instant to the customer. Never let the customer-facing inline response be the only thing that writes order state.

### Webhook security — the single most important implementation detail

- Delivery headers: `X-Webhook-Event`, `X-Webhook-Timestamp`, `X-Webhook-Delivery-Id`, and `X-Webhook-Signature`.
- Signature scheme (verbatim): HMAC-SHA256 over `${X-Webhook-Timestamp}.${rawJsonBody}`, compared against `X-Webhook-Signature` in the format `sha256=<hex>`.
- **The docs say the signature is sent "only when a secret is configured."** If no signing secret is configured, your webhook endpoint is unauthenticated and anyone who discovers the URL can forge a "payment verified" callback. Configure the secret, and make your endpoint **reject any request without a valid signature** — do not fall back to accepting unsigned deliveries.
- Retry policy: up to 5 attempts — immediate, 30s, 2m, 8m, 30m. Default timeout 30 seconds. So your endpoint **will** receive duplicates; dedupe on `X-Webhook-Delivery-Id` and `requestId`.
- Production webhook URLs must be HTTPS, must not contain credentials, must resolve in DNS, and must not point at private or reserved network addresses.

The docs do not state whether the timestamp is seconds or milliseconds, nor a recommended tolerance window for replay rejection. Confirm with the vendor (see §8).

---

## 6. Error and back-pressure states — all recoverable, all must be handled

| Code | Meaning | Correct handling |
|---|---|---|
| 401 | Invalid API key | Alert. Do not retry. |
| 403 | Permission denied (e.g. `verification:write` required) | Config error. Alert, do not retry. |
| 409 | Idempotency key already used for a *different* verification request | Bug in key derivation. Log loudly. |
| 422 | Invalid bank-specific payload | Validate before submit; surface a specific field error to the user. |
| 429 | API key rate limit exceeded, or queue saturated | Respect `Retry-After`. Back off, queue locally. |
| 402 | Verification credits exhausted (shared account balance) | **Business-critical.** Fall back to manual review, alert ops, do not fail the customer's order silently. |
| 503 | Verification queue unavailable | A status URL is returned when a request row was created — persist it and reconcile later. |

Credits behaviour from the dashboard banners: plan credits apply only to the active anchored cycle, **do not roll over**, and changing plans replaces the previous allowance immediately. Credits are consumed by dashboard, mobile and API usage against the same balance — so a person clicking around the dashboard can starve your production checkout. Monitor `GET /api/credits/balance` and alarm well before zero.

---

## 7. Prompts for your implementing agent

Paste these in order. Each is self-contained. **Prompt 0 is not optional** — the rest assume the agent has produced that recon note, since neither I nor the agent has seen your codebase.

Give the agent a copy of this document alongside Prompt 0 so it has the verified contract and does not invent endpoints.

---

### Prompt 0 — Recon (run first, no code changes)

```
Do not write or modify any code in this task. Produce a written recon note only.

We are integrating a third-party payment-receipt verification API (Verify.ET, an Ethiopian
bank/wallet transaction verification service) into this codebase. Before any design work,
map what already exists. Investigate and report:

1. Language, framework, and runtime versions. How HTTP clients are conventionally created
   here (existing wrapper? retry/timeout middleware? shared base client?).
2. Where secrets and config come from (env vars, secret manager, config service). Show me an
   existing example of a third-party API credential being read, so the new one follows the
   same pattern.
3. Where inbound webhooks from third parties are received today, if anywhere. Show me the
   route, the signature-verification code, and whether raw request bodies are preserved
   before JSON parsing. If no webhook endpoint exists, say so explicitly.
4. The payment/order domain model: which tables or entities represent a payment or an order,
   what status enums exist, where status transitions happen, and whether there is an audit or
   event log.
5. Existing background job / queue / scheduler infrastructure available for retries and
   reconciliation.
6. Existing observability: logging, metrics, alerting. How would a new alert be wired?
7. Test infrastructure: framework, how external HTTP is stubbed, whether there are
   integration tests that hit real services.
8. Whether any Ethiopian bank or wallet payment handling already exists (search for: CBE,
   Telebirr, telebirr, M-Pesa, mpesa, Abyssinia, BOA, Awash, Dashen, Siinqee, ETB).

For each point cite concrete file paths. If something does not exist, say "does not exist"
rather than describing what a typical codebase would have. End with the three biggest
constraints this codebase imposes on adding a new asynchronous third-party verification flow.
```

---

### Prompt 1 — Design the integration before building it

```
Using the recon note and the attached Verify.ET contract document, write an implementation
design doc for integrating Verify.ET into this codebase. No code yet.

Cover:
- Where the integration boundary sits: a dedicated module/service vs. extending existing
  payment code. Justify against this codebase's existing structure.
- The state machine for a payment-verification attempt, with every state and transition,
  including states for: submitted, queued, completed-accepted, completed-rejected,
  needs-manual-review, credit-exhausted, provider-unavailable, and abandoned.
- How the verification record relates to the existing order/payment entities.
- Which of the four result-collection mechanisms (inline waitMs, polling, SSE, webhook) we
  use and why, given this codebase's actual infrastructure. If no public webhook endpoint can
  be exposed, say so and design around it.
- Idempotency strategy: exactly what value becomes the Idempotency-Key, and why it is stable
  across retries but distinct across genuinely different submissions.
- What we persist vs. what we discard. Note that responses contain personal data
  (senderName, receiverName, masked receiverAccount) — apply this codebase's existing PII
  handling conventions and name them.

Flag every place where the vendor's documentation is silent and we would be guessing.
Do not fill those gaps with assumptions; list them as open questions.
```

---

### Prompt 2 — Config, secrets, typed client

```
Implement the Verify.ET HTTP client only. No business logic.

Requirements:
- Base URL https://verify.et, overridable by config. There is no sandbox environment, so the
  client must support a config-level "disabled/dry-run" mode that returns a clearly-marked
  stub instead of calling out, for use in local dev and tests.
- Auth: x-api-key header. The key has the prefix VERIFY_BANK_ET_. Read it via this
  codebase's existing secret mechanism (see recon note). It must never be logged, never
  appear in an exception message, and never reach the client/browser side.
- Typed request and response models for: POST /api/verify, GET /api/verify/:requestId,
  GET /api/verify/history, POST /api/verify/test-webhook.
- Handle the documented envelope: success, message, data — plus requestId, verification, and
  links on submissions.
- CRITICAL shape handling, from the vendor docs: `data` is an ARRAY on POST /api/verify but an
  OBJECT on GET /api/verify/:requestId. Model both correctly; do not assume one shape.
- CRITICAL money handling: `amount` appears as a number (1500) in the synchronous response
  example and as a string ("1500") in the webhook example. Accept both, normalise to this
  codebase's decimal/money type. Never use a binary float for money.
- `accountSuffix` and all suffix/reference/phone values are STRINGS. Never coerce to integer —
  leading zeros are significant.
- Distinct typed errors for 401, 402, 403, 409, 422, 429, 503, plus network/timeout. Parse and
  expose the Retry-After header on 429. Capture the x-request-id response header on every
  call and attach it to logs and errors for vendor support.
- Timeouts and a bounded retry policy for idempotent GETs only. Do NOT auto-retry POST
  /api/verify without an Idempotency-Key.

Follow this codebase's existing HTTP client conventions from the recon note rather than
introducing a new library. Unit test with stubbed HTTP.
```

---

### Prompt 3 — Submit path and request validation

```
Implement submitting a verification.

Validate bank-specific payloads BEFORE calling the API, so we fail locally instead of burning
a paid credit on a 422. Per the vendor docs:

  cbe        -> referenceNumber + accountSuffix, exactly 8 digits
  boa        -> referenceNumber + accountSuffix, exactly 5 digits
  telebirr   -> transactionNumber or reference
  mpesa      -> transactionNumber or reference (receipt URLs / supported SMS text also accepted)
  cbebirr    -> receiptNumber + phone/phoneNumber
  dashen     -> referenceNumber or reference
  awash      -> referenceNumber or reference
  siinqee    -> referenceNumber or reference
  kaafiebirr -> referenceNumber or reference; phone optional. Bare tokens require explicit bank.
  zemen      -> NOT SUPPORTED for direct submission. Reject before calling the API with a
                clear message; do not send it and do not spend a credit.

Also:
- Support the universal router (omit `bank`, send `reference` + optional `suffix`/`phoneNumber`),
  but prefer explicit `bank` whenever our own checkout already knows the provider — the docs
  state explicit bank always wins and gets strict validation.
- Normalise phone input: accept 09XXXXXXXX and 251XXXXXXXXX; the API normalises to
  251XXXXXXXXX.
- Always send an Idempotency-Key using the strategy from the design doc.
- Always send `settlementAccount` when we know the receiving account for that order. Do not
  rely on the saved-account fallback silently — make it an explicit, logged configuration
  decision which mode a given payment flow uses.
- Handle 200 (terminal) and 202 (queued) as distinct paths. On 202, persist requestId and
  links.statusUrl and hand off to the async collector. Respect links.pollAfterMs and
  estimatedWaitMs rather than hardcoding intervals.
- If we use ?waitMs, treat it strictly as a latency optimisation. The queued path must be
  fully functional on its own.

Do not implement the accept/reject decision here — that is a separate task.
```

---

### Prompt 4 — Webhook receiver

```
Implement the Verify.ET webhook receiver. Treat this as a security-critical endpoint.

Per the vendor docs:
- Event: verification.completed. Payload: { event, requestId, timestamp, data: { ... } }.
- Headers: X-Webhook-Event, X-Webhook-Timestamp, X-Webhook-Delivery-Id, X-Webhook-Signature.
- Signature: HMAC-SHA256 over `${X-Webhook-Timestamp}.${rawJsonBody}`, compared against
  X-Webhook-Signature in the format sha256=<hex>.

Requirements:
- Verify the signature against the raw, unparsed request body. Confirm this codebase's
  framework does not consume or re-serialise the body before we can read it; if it does, fix
  that for this route specifically.
- Use a constant-time comparison.
- The vendor docs say the signature is sent ONLY when a signing secret is configured. Our
  endpoint must REJECT any request lacking a valid signature — no fallback to accepting
  unsigned payloads, not even behind a config flag. If the secret is not configured, the
  endpoint must refuse to start/serve rather than accept unsigned traffic.
- Reject stale timestamps to prevent replay. The docs do not specify the timestamp unit or a
  tolerance window — detect the unit defensively (seconds vs milliseconds), pick a
  conservative window, and leave a comment marking this as unconfirmed with the vendor.
- Idempotent processing: dedupe on X-Webhook-Delivery-Id and requestId. The documented retry
  policy is 5 attempts (immediate, 30s, 2m, 8m, 30m) with a 30s timeout, so duplicates and
  out-of-order delivery are expected, not exceptional.
- Return 2xx quickly and do the real work in a background job — a slow handler causes vendor
  retries and duplicate processing.
- Never trust webhook body values over a follow-up authoritative read. On receipt, re-fetch
  GET /api/verify/:requestId with our API key before making any money decision, and use that
  as the source of truth.
- Correlate the requestId to our own verification record. An unknown requestId must be logged
  and discarded, never auto-created.

Then wire POST /api/verify/test-webhook (body: { webhookUrl, scenario }) into a manual ops
command so we can validate the endpoint without a real transaction.
```

---

### Prompt 5 — Reconciler / fallback collector

```
Implement the fallback path so no verification can get stuck.

- A background job that finds verification records not in a terminal state and polls
  GET /api/verify/:requestId until processingStatus is `completed` or `failed`. Respect
  links.pollAfterMs; use exponential backoff with a hard attempt ceiling and a terminal
  "abandoned — needs manual review" state. Never poll forever.
- Handle 503 on submit specially: the docs say a status URL is returned when a request row was
  created, so persist it and let the reconciler pick it up.
- Optionally implement the SSE path (GET /api/verify/:requestId/events, accept:
  text/event-stream) if and only if our UI needs live status. It emits `status` events and
  closes with a `done` event whose reason is `terminal` or `timeout`. Treat `timeout` as
  non-terminal and hand back to polling. Do not use SSE as the sole result mechanism.
- Add a daily consistency check against GET /api/verify/history (filters: bank, status,
  processingStatus, startDate, endDate, limit, offset; paginate via meta.total/limit/offset)
  to detect verifications the vendor considers finished that we never recorded as terminal.
  Report discrepancies; do not auto-mutate order state from this job.
```

---

### Prompt 6 — The acceptance decision (most important task; review this one carefully)

```
Implement the decision logic that turns a verification result into an accept / reject /
manual-review outcome. Do not shortcut this to `if (verified) accept`.

A payment may be ACCEPTED only if ALL of the following hold:

1. processingStatus == "completed" AND status == "success" AND verified == true.
2. Amount and currency match what we expect for the order, within an explicit tolerance
   defined in config (default: exact match). Compare using a decimal type. Currency must be
   the expected one, not merely present.
3. settlementAccountMatch.matched == true — i.e. the money reached OUR account. Additionally:
     - If settlementAccountMatch.ambiguous == true, route to MANUAL REVIEW regardless of any
       other field. The vendor returns matched:false with ambiguous:true and a candidate count
       instead of guessing between saved accounts; we must not guess either.
     - Treat reasons `no_registered_accounts` and `missing_receiver_account` as
       CONFIGURATION FAILURES on our side — alert ops loudly and route to manual review. They
       are not customer-fault rejections.
     - Treat `candidate_account_mismatch` as a genuine rejection: real receipt, wrong receiver.
     - Consider matchConfidence when deciding auto-accept vs. review; require high confidence
       for auto-accept and make the threshold configurable.
4. Replay check, combining vendor data with our own records:
     - confirmationHistory.scope is "platform", so confirmedBefore == true can mean another
       merchant confirmed it, or that WE retried. It is not by itself proof of fraud.
     - The authoritative anti-double-spend check is OUR OWN uniqueness constraint: enforce a
       database-level unique constraint on (bank, reference identifier) for accepted payments,
       so the same receipt can never settle two of our orders even under concurrent requests.
     - Use confirmationHistory (isFirstConfirmation, confirmedBefore, confirmationCount,
       firstConfirmedAt, lastConfirmedAt) as a risk signal that raises the review threshold,
       and log it in full on every decision.

Requirements:
- Every decision writes an immutable audit record: full inputs, the vendor's requestId, the
  x-request-id response header, the complete settlementAccountMatch and confirmationHistory
  objects, the rule that decided the outcome, and a timestamp. This is the evidence trail for
  a payment dispute.
- Manual review must be a real, reachable state with an operator surface — not a TODO.
- Handle every documented settlementAccountMatch reason code explicitly. An unrecognised or
  newly-added reason code must default to MANUAL REVIEW, never to accept.
- Apply the same rule for unknown enum values anywhere: fail closed.
- Write exhaustive unit tests for the decision function, including: verified-but-wrong-amount,
  verified-but-wrong-receiver, verified-but-ambiguous-match, verified-but-already-accepted-
  locally, no-registered-accounts, and each unknown-enum path.

The failure mode to design against: this function silently approving a payment we never
received. Bias every ambiguous case toward manual review.
```

---

### Prompt 7 — Failure handling, credits, observability

```
Make the integration's failure modes explicit and visible.

Map each documented API error to defined behaviour:
  401 invalid API key            -> alert, no retry, circuit break
  403 permission denied          -> alert (key lacks verification:write/read), no retry
  409 idempotency key reused for a different request -> log as a bug, alert
  422 invalid bank payload       -> surface a specific field error; should be rare because we
                                   validate locally first. Track the rate as a signal our
                                   validation drifted from the vendor's.
  429 rate limit / queue saturated -> honour Retry-After, back off, local queue, alert on
                                   sustained 429
  402 credits exhausted          -> CRITICAL. Degrade to manual review, page ops, and make
                                   sure the customer gets a clear "we're confirming your
                                   payment manually" experience rather than a failed order
  503 queue unavailable          -> persist any returned status URL, hand to reconciler, alert
                                   on sustained 503

Credits (from the vendor dashboard): credits are ACCOUNT-LEVEL and shared across dashboard,
mobile app and API usage on the same balance. Plan credits apply only to the active anchored
cycle, DO NOT roll over, and changing plans replaces the previous allowance immediately.
Therefore:
- Poll GET /api/credits/balance on a schedule; expose it as a metric; alarm at configurable
  warning and critical thresholds well before zero. A person browsing the vendor dashboard can
  drain the same balance our checkout depends on.
- Never let credit exhaustion silently fail a customer payment.

Instrument: submit count by bank, outcome distribution (accept/reject/review), settlement
match reason-code distribution, p50/p95/p99 time-to-terminal by bank, 402/429/503 rates,
webhook signature-failure count (any non-zero value is a security signal), duplicate-delivery
count, and reconciler-rescued count. Log the vendor's x-request-id on every call.

Add a circuit breaker: if the vendor is failing broadly, stop submitting, put payments into
manual review, and surface that state on our status/ops dashboard.
```

---

### Prompt 8 — Tests, given there is no sandbox

```
Build the test strategy. Constraint: Verify.ET publishes NO sandbox or staging environment —
the docs direct integrations to the production base URL. So:

- Unit tests: exhaustive coverage of the decision function and of per-bank payload validation
  (including the exact 8-digit CBE and 5-digit BOA suffix rules, and the zemen rejection).
- Contract tests against recorded fixtures built from the vendor's documented examples. Include
  fixtures for: 200 completed, 202 queued, matched settlement, unmatched/no-registered-accounts
  settlement, ambiguous match, and each documented error code.
- Deliberately include fixtures for the type inconsistencies: `data` as array vs. object,
  `amount` as number vs. string. A test must fail if someone "simplifies" either away.
- Webhook tests: valid signature, invalid signature, missing signature header, stale timestamp,
  replayed delivery id, and body-tampered-after-signing.
- A documented manual smoke-test procedure for production, using the smallest real transaction
  we can make, with a checklist of exactly what to verify. Include POST /api/verify/test-webhook
  for endpoint validation.
- Do NOT write automated tests that call the live production API on every CI run — each call
  consumes a paid credit from the shared account balance. If any live test exists, put it behind
  an explicit opt-in flag and document its cost.
```

---

### Prompt 9 — Ops surface and documentation

```
Produce the operational layer.

- A runbook: what to do on sustained 402 (credits), 429, 503, webhook signature failures, and
  a stuck-verification backlog. Include how to manually re-drive a verification and how to
  manually accept or reject a payment with an audit trail.
- An internal doc covering: how to rotate the API key (note that key creation requires a
  dashboard session, not an API call, and the secret is shown only once), which permissions
  our key needs and why, and where the signing secret lives.
- An ops view listing verifications in manual-review state with the full evidence — vendor
  requestId, settlementAccountMatch, confirmationHistory, amount/currency expected vs.
  received — so a human can decide without opening a database client.
- A short section for support staff in plain language: what "ambiguous match" and
  "confirmed before" actually mean when they are talking to a customer.
```

---

### Guardrails to repeat in every prompt

Paste this block at the end of each prompt above:

```
Constraints:
- Do not invent endpoints, fields, enum values, error codes, or headers. Use only what is in
  the supplied Verify.ET contract document. If you need something that isn't documented, stop
  and list it as an open question instead of guessing.
- Do not install a third-party Verify.ET SDK or agent skill. Build against the documented REST
  contract using this codebase's existing HTTP conventions.
- Fail closed. Any unknown status, unrecognised enum, ambiguous match, or unexpected response
  shape routes to manual review — never to automatic acceptance.
- The API key and webhook signing secret are server-side only. They must never be logged,
  echoed in errors, committed, or exposed to any client.
- Remember there is no sandbox. Any code path that calls the live API spends real money from a
  shared, non-rolling credit balance.
```

---

## 8. Open questions to put to Verify.ET before you commit engineering time

These are gaps in the published documentation, not oversights on our side. I'd get written answers before scheduling the build.

1. **Is there any test or sandbox environment?** The docs point integrations at production. Developing a payment gate against live-only infrastructure is a real risk.
2. **Webhook signing secret** — where is it configured, and is the `X-Webhook-Timestamp` in seconds or milliseconds? What replay tolerance do you recommend? Can signing be *enforced* account-wide so it cannot be accidentally left off?
3. **Pricing and credit cost per verification.** The public page shows only "Enterprise Plan — Custom Pricing — Contact Sales." What does one verification cost, do failed or 422 requests consume credits, and what happens when the balance hits zero mid-cycle?
4. **How is verification performed?** If it depends on bank portals or receipt pages, that determines latency, reliability, and what happens during a bank outage. What is the observed p95 time-to-terminal per bank?
5. **SLA, uptime history, and support escalation path.** There are uptime endpoints — what commitment sits behind them?
6. **Data handling.** Responses contain sender and receiver names and masked account numbers. What is retained, for how long, where is it hosted, and what are the deletion terms? This matters for whatever privacy regime ReiCB operates under.
7. **Legal entity, contract terms, and liability** if a verification returns a false positive and we release goods or funds against it.
8. **Zemen timeline**, and how new banks are announced — we need a versioning/changelog commitment so enum additions don't silently break our fail-closed logic.
9. **Rate limits** — actual numbers per key, and whether limits are per key or per account.
10. **`X-Verify-Cache: HIT`** — results are cached. For how long? Could we receive a stale result for a transaction whose status changed?

---

## 9. Immediate next steps for you

1. Confirm this is genuinely the right tool — it only verifies **Ethiopian** bank and wallet receipts. If ReiCB isn't collecting Ethiopian payments, stop here.
2. Get answers to §8, especially pricing and the sandbox question.
3. Activate a plan and create an API key scoped to `verification:read` + `verification:write`, storing the secret in your secret manager the moment it's shown.
4. Register your settlement accounts via `/api/bank-accounts` — otherwise settlement matching returns `no_registered_accounts` and the strongest fraud control does nothing.
5. Run Prompt 0 against your codebase, then Prompt 1, and review that design doc before authorising any implementation.
