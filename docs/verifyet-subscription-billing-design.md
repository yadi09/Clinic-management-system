# Design — Subscription billing for clinics, verified with Verify.ET

Status: **proposed, not built** · Author: Claude · 22 Aug 2026
Companion to `verifyetintegrationhandoff.md` (the vendor contract). Where the two
disagree about the vendor's behaviour, the handoff wins — it was read from their docs.

---

## 0. The scenario this exists for

Sister Alem owns Cure Dental. On the 1st of the month ClinicOS shows her a banner:
*"Your Clinic plan — 1,500 ETB for 1–30 September — is due."* She opens her CBE app,
transfers 1,500 ETB to ReiCB's account, and gets the confirmation SMS. She clicks
**"I've paid"** in ClinicOS, picks CBE, pastes the reference and the last 8 digits of
her account, and presses Confirm.

Four seconds later the banner is gone and the invoice says **Paid · verified**. Nobody
at ReiCB touched anything, and the money is real — checked against the bank, against
*our* account, for the right amount, and against every reference ever accepted before.

If any part of that is uncertain, she instead sees *"We're checking with the bank —
we'll confirm within the day"*, and the invoice lands in a super-admin review queue
with the full evidence attached. **She is never blocked from her patients.**

---

## 1. Why this first (and what it is really fixing)

The verification is the small part. The real gap:

> Today nothing in ClinicOS records that a clinic has paid us. `subscriptions` has a
> `status` (`trialing|active|past_due|cancelled`) and `current_period_start/end`, and
> **nothing can ever set `past_due` automatically** because no code knows what was
> owed or whether it arrived. `billing_accounts` is created at provisioning
> (`internal/platform/provision/provision.go:209`) and then never read again. There
> is no invoice table and no payment record anywhere in 62 migrations.

So this feature is: **invoices for our own subscriptions, paid by bank transfer,
confirmed automatically.** Verify.ET is one component of it.

It is also deliberately the *safest* place to build the integration:

| | Clinics paying us (this doc) | Patients paying clinics (later) |
|---|---|---|
| Merchant | One: ReiCB | ~N clinics, each with own accounts |
| Volume | ~1 per clinic per cycle (100 clinics ≈ 100–300/mo) | Hundreds per clinic per month |
| Settlement matching | Our own accounts, saved at the vendor | Must scope per clinic on every call |
| Blast radius if wrong | An invoice is wrong; ops fixes it | A patient is told they paid when they didn't |
| Clinical impact if broken | None | Cashier desk stops |

Everything built here — client, decision function, webhook receiver, audit trail,
reconciler — is reused for patient payments. That is the point of starting here.

---

## 2. Cost, settled

Dev Plus: 500/month → 5,000 API verifications = **0.10 ETB each**. Dev Pro: 3,000/month
→ 30,000 = the same unit price. A verification costs **less than half an SMS segment**
(0.25 ETB), so cost is not a design constraint for this use case at any plausible
clinic count. Dev Plus covers 100 clinics roughly 20× over.

Two traps in their pricing page: **"Verify Pro (App) — 4,000/year — unlimited" is
App-only, not API** — it cannot serve an integration. And the quoted monthly figures sit
under the "3 Month" tab, so they are likely billed quarterly; the 6-month and yearly
tabs may be cheaper.

---

## 3. What exists to build on

| Need | Existing pattern to follow |
|---|---|
| Config-gated outbound client | `internal/kernel/dhis2`, `internal/kernel/sms`; gated by `cfg.DHIS2.Configured()` style |
| Encrypted credential at rest | `auth.EncryptSecret` / `DecryptSecret`, AES-256-GCM (`internal/kernel/auth/crypto.go`) |
| Background collector w/ retry + stuck recovery | the messaging dispatcher + reconciler in `cmd/worker/main.go`, on the privileged pool |
| Cross-tenant work from a worker | `PLATFORM_DATABASE_URL` privileged pool, then re-enter RLS per tenant |
| Quota enforcement | `internal/kernel/limits` (SMS segments) |
| Money | `NUMERIC` in DB, decimal strings on the wire — never a float |
| Public (unauthenticated) route | `identityHandlers.RegisterPublic(v1)`, `cmd/api/main.go:231` |
| Opaque ids | `internal/kernel/id` prefixes |

**What does not exist: any inbound webhook.** The only mention in the codebase is the
comment in `internal/messaging/dispatch/reconcile.go` explaining why we poll the SMS
gateway instead. This will be the product's first, so raw-body preservation and
signature verification are new ground and must be treated as such.

---

## 4. Data model — migration `00063_subscription_billing.sql`

Three new tables. All carry `tenant_id` and get the standard treatment used by
`subscriptions`: `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy,
and the `clinic_app` grant. A clinic reads its own invoices with its own session; the
super-admin reads across tenants on the privileged pool.

### `subscription_invoices`
```
id, tenant_id, plan_id,
period_start DATE, period_end DATE,
amount_due NUMERIC(12,2), currency TEXT DEFAULT 'ETB',
status TEXT CHECK (status IN ('open','paid','void','uncollectible')),
issued_at, due_at, paid_at,
created_by, created_at, updated_at
UNIQUE (tenant_id, period_start)        -- one invoice per tenant per cycle
```
`amount_due` is snapshotted from `plans.price_monthly` at issue time, not read live —
a price change next quarter must not rewrite what a clinic was already invoiced.

### `subscription_payments`
One row per **attempt** by a clinic to prove payment. This is the audit spine.
```
id, tenant_id, invoice_id,
bank TEXT, reference TEXT, reference_norm TEXT, account_suffix TEXT, phone TEXT,
claimed_amount NUMERIC(12,2),
state TEXT CHECK (state IN
  ('submitted','queued','accepted','rejected','needs_review','abandoned')),
decision_reason TEXT,                    -- our rule that decided it
vendor_request_id TEXT,                  -- Verify.ET requestId
vendor_x_request_id TEXT,                -- their x-request-id header, for support
vendor_status TEXT, vendor_processing_status TEXT, vendor_verified BOOLEAN,
verified_amount NUMERIC(12,2), verified_currency TEXT,
settlement_match JSONB,                  -- the whole object, verbatim
confirmation_history JSONB,              -- the whole object, verbatim
sender_name TEXT, receiver_name TEXT, receiver_account TEXT,
attempts INT DEFAULT 0, next_poll_at TIMESTAMPTZ,
submitted_by, created_at, updated_at
```

**The anti-double-spend constraint** — the single most important line in the migration:
```sql
CREATE UNIQUE INDEX uq_subscription_payment_reference
  ON subscription_payments (bank, reference_norm)
  WHERE state = 'accepted';
```
Deliberately **not** scoped by `tenant_id`. All these transfers go to the same ReiCB
account, so one transfer must never settle two clinics' invoices. A unique index is
physical and enforces across tenants even though RLS hides the rows — clinic B simply
gets "this reference has already been used", learning nothing about clinic A. This
constraint, not the vendor's `confirmationHistory`, is our authoritative guard.

### `verifyet_webhook_deliveries`
```
delivery_id TEXT PRIMARY KEY,            -- X-Webhook-Delivery-Id
request_id TEXT, event TEXT, received_at, processed_at, outcome TEXT
```
Not tenant-scoped: it exists before we know which tenant the delivery belongs to.
Their retry policy is 5 attempts (immediate, 30s, 2m, 8m, 30m), so duplicates are
routine, not exceptional.

Also: `ALTER TABLE billing_accounts ADD COLUMN pay_to_account_id UUID` — which of our
bank accounts this tenant was told to pay into (see §6).

Suggested id prefixes: `sbi` (invoice), `spy` (payment). `inv` is taken by invitations.

---

## 5. Module boundary

- **`internal/kernel/verifyet`** — the HTTP client and nothing else. Typed requests and
  responses, the envelope, the two shape traps, typed errors per status code, no
  business logic. Mirrors `kernel/sms` and `kernel/dhis2`.
- **`internal/subscription`** — invoices, payment attempts, the decision function, the
  tenant-facing API. Owns the state machine.
- **`internal/platform`** — the super-admin surface: issue/void invoices, the review
  queue, manual accept/reject with a reason.
- **`cmd/worker`** — the reconciler goroutine, alongside the existing message dispatcher.

The client never imports the subscription module; the subscription module never builds
HTTP requests. That split is what lets patient payments reuse the client untouched.

---

## 6. Settlement accounts — the fraud control, configured

`settlementAccountMatch` only works if the vendor knows our accounts. Two steps:

1. Register ReiCB's receiving accounts at Verify.ET via their `/api/bank-accounts`
   (a dashboard/ops task, not something our backend bootstraps).
2. Store the same accounts in our config so we can send `settlementAccount` explicitly.

For this use case the saved-account fallback would be safe (single merchant), but we
should still send it explicitly whenever we know which account the clinic was told to
pay into, because:
- it makes the check specific rather than "any account we own";
- it is the exact code path patient payments will require, where the fallback is
  **not** safe — and I would rather that path be the well-worn one.

**Only offer the banks we actually hold accounts with.** The clinic is paying into our
account, so the bank is determined by which account they were given — most likely CBE
and Telebirr only. That collapses the per-bank validation surface from ten banks to
two, and `zemen` (unsupported for direct submission) never arises.

---

## 7. State machine

```
                        ┌─────────────┐
   clinic submits ─────►│  submitted  │
                        └──────┬──────┘
             200 terminal │    │ 202 queued / 503 with status URL
                  ┌───────┘    └────────┐
                  ▼                     ▼
            [decision]            ┌──────────┐
                  │               │  queued  │◄── reconciler polls, webhook lands
                  │               └────┬─────┘
                  │                    │ terminal result
                  │                    ▼
                  │              [decision]
                  ▼                    │
   ┌──────────┬───┴────────┬───────────┴────┐
   ▼          ▼            ▼                ▼
accepted   rejected   needs_review      abandoned
   │                       │ (super-admin decides)
   │                       └──► accepted | rejected  (manual, with reason + actor)
   ▼
invoice.status = 'paid', paid_at set, subscription period rolled forward
```

`abandoned` is reached only by the reconciler hitting its attempt ceiling. It is a
terminal state that **means "a human must look"**, not "give up" — it appears in the
same review queue.

Every transition writes to `kernel/audit` with the actor (a user id, or `system`).

---

## 8. Result collection

The clinic owner is sitting in front of the screen having just pasted a reference, so:

1. **Submit with `?waitMs=5000`.** Most verifications should return 200 terminal and she
   gets her answer immediately. This is a latency optimisation *only*.
2. **On 202**, persist `requestId` + `links.statusUrl`, return "checking…" to the browser,
   and let the frontend poll *our* endpoint (never the vendor's) while the server works.
3. **Webhook is the source of truth for state.** It writes the terminal result even if
   she closes the tab.
4. **Reconciler** catches anything the webhook missed, and is the only thing that can
   declare `abandoned`.

The browser response never writes money state. The server does, in one place.

SSE is not worth it here: one user, one short wait, and it would be a second live
transport for no gain.

---

## 9. Idempotency

`Idempotency-Key` = a hash of `invoice_id | bank | reference_norm`.

Stable across retries of the same claim (a network timeout, a double-click, a
reconciler re-submit) so we never spend two credits on one claim. Distinct when the
clinic corrects a typo and submits a *different* reference. Contains no timestamp and
no attempt counter — those are exactly what would break it.

A 409 from the vendor (key reused for a genuinely different payload) is therefore a bug
in our key derivation, and must be logged and alerted, never retried.

---

## 10. The acceptance decision

Single function, pure, exhaustively tested, no I/O. Accept **only if all hold**:

1. `processingStatus == "completed"` AND `status == "success"` AND `verified == true`.
2. `amount` equals `invoice.amount_due` exactly (decimal compare; tolerance configurable,
   default zero) and `currency == "ETB"`.
3. `settlementAccountMatch.matched == true` with `matchConfidence == "high"`.
4. Our own uniqueness constraint accepts the reference (§4).

Everything else routes as follows:

| Condition | Outcome |
|---|---|
| `ambiguous == true` | **needs_review** — the vendor refused to guess; we must not either |
| reason `no_registered_accounts` / `missing_receiver_account` | **needs_review** + loud ops alert. Our misconfiguration, not the clinic's fault |
| reason `candidate_account_mismatch` | **rejected** — real receipt, wrong receiver |
| amount short/over | **needs_review** (a clinic paying 1,400 of 1,500 is a conversation, not a fraud) |
| `confirmedBefore == true` | not fraud by itself — `scope` is `platform`. Raises the bar to `needs_review` unless our own records show the earlier confirmation was our retry |
| any unknown enum, reason code, or shape | **needs_review**. Fail closed, always |

Every decision writes an immutable row: inputs, `requestId`, their `x-request-id`, the
full `settlementAccountMatch` and `confirmationHistory` JSON, the rule that fired, the
actor, the timestamp. That is the evidence if a clinic disputes a charge a year later.

**The failure mode being designed against:** marking an invoice paid for money we never
received. Every ambiguity biases to review.

---

## 11. What we keep, and what we never log

Responses carry `senderName`, `receiverName`, masked `receiverAccount`. For this use
case that is business data (a clinic's own bank details), not patient PHI — but it is
still personal and it is evidence, so:

- **Persist** it on the payment row: it is the dispute trail.
- **Never** write it to application logs. Logs get `requestId`, `x-request-id`, tenant,
  invoice, outcome, reason — never names, references, or account numbers.
- The API key and webhook signing secret are server-side only, never logged, never in
  an error message, never sent to the browser.

---

## 12. Failure handling

| Code | Behaviour |
|---|---|
| 401 | Alert, circuit-break, no retry. Key is wrong or revoked |
| 403 | Alert. Key lacks `verification:write`/`read` |
| 409 | Bug in our idempotency key. Log loudly, alert, do not retry |
| 422 | Should be near-zero because we validate locally first; surface the field error to the clinic and track the rate as a drift signal |
| 429 | Honour `Retry-After`, back off, queue locally |
| 402 | **Credits exhausted.** Degrade to manual review, page ops, and tell the clinic "we're confirming manually" — never a failed-looking error |
| 503 | Persist any returned status URL, hand to the reconciler |

Credits are account-level and shared with their dashboard and mobile app, and do not
roll over. Poll `GET /api/credits/balance` on a schedule, expose it as a metric, alarm
well before zero. At ~300 verifications a month against 5,000 this is slack, but the
alarm still goes in — someone browsing their dashboard spends the same balance.

**Non-payment must never block clinical work.** My recommendation, to be confirmed: an
overdue invoice shows a banner, then after a configurable grace period restricts
*administrative* actions only. A clinic locked out of a patient record mid-consultation
because an invoice is late is a patient-safety event, not a collections tactic.

---

## 13. Testing without a sandbox

- Unit: the decision function, exhaustively — wrong amount, wrong receiver, ambiguous,
  already-accepted, no-registered-accounts, and every unknown-enum path.
- Contract: recorded fixtures from the vendor's documented examples, **including** the
  two shape traps (`data` array vs object; `amount` number vs string). A test must fail
  if someone "simplifies" either away.
- Webhook: valid, invalid, missing signature, stale timestamp, replayed delivery id,
  body tampered after signing.
- A dry-run client mode for local dev and CI, returning clearly-marked stubs.
- No live calls in CI. One documented manual smoke test in production, using the
  smallest real transfer we can make.
- If the Starter free tier permits API calls, that becomes the substitute for the
  missing sandbox (see §15).

---

## 14. Build order

1. **Invoices, no vendor at all.** Issue per cycle, show the clinic what it owes,
   super-admin marks paid by hand. This alone fixes "nothing knows whether a clinic
   paid", and it gives manual review a real operator surface before anything can route
   into it.
2. **The client** (`kernel/verifyet`) + submit + the decision function + audit. Clinic
   self-serves; still no webhook — poll only.
3. **Webhook receiver + reconciler.** Terminal state without a browser.
4. **Credits monitoring, metrics, runbook.**
5. *(Later, separate)* patient payments at the cashier, reusing 2–4 unchanged.

Steps 1 and 2 are each independently shippable and independently useful.

---

## 15. Open questions for Verify.ET

Narrowed to what still blocks or shapes the build:

1. **Starter "Free (Limited)"** — does it allow API calls, and how many? This is our only
   candidate for a non-production test path.
2. **Do failed, unverified or 422 requests consume a credit?**
3. **Webhook signing:** where is the secret configured, is `X-Webhook-Timestamp` in
   seconds or milliseconds, what replay tolerance do you recommend, and can signing be
   enforced account-wide so it cannot be left off by accident?
4. **`X-Verify-Cache: HIT`** — what is the TTL, and can we receive a stale result for a
   transaction whose status has since changed?
5. **Rate limits** — actual numbers, per key or per account?
6. **Data retention and deletion terms** for the names and account numbers in responses.
7. **Changelog/versioning commitment** for new banks and enum values, so our fail-closed
   logic degrades to review rather than breaking silently.
8. **3-month vs 6-month vs yearly** effective pricing, and what happens to unused credits
   on a plan change mid-cycle.

Nothing in §14 step 1 depends on any of these. Step 2 needs 1, 2 and 8; step 3 needs 3.

---

## 16. Explicitly out of scope here

- Patient payments at the cashier (the reason this is built first, but a separate design).
- Card/online payment rails. Verify.ET verifies transfers; it does not take payment.
- Automatic suspension for non-payment beyond the banner/grace-period rule in §12.
- Any per-clinic Verify.ET account. One platform account, ours. When patient payments
  come, a clinic may optionally supply its own key using the encrypted per-clinic
  credential pattern already proven for SMS and DHIS2.
