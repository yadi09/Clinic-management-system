# SMSEthiopia SMS Gateway — API Integration Guide

How to send SMS from our codebase using the SMSEthiopia gateway (operated by Alet Technology).

Everything here is taken from their published API reference at `https://smsethiopia.com/#/api-reference`. Nothing is assumed or extrapolated; anything their docs leave unspecified is called out explicitly in the last section.

---

## 1. The shape of the API

| | |
|---|---|
| Base URL | `https://smsethiopia.com/api/` |
| Protocol | HTTPS only. Plain HTTP is redirected, and most HTTP clients drop the POST body on redirect |
| Format | REST, JSON in and out |
| Auth | API key in a request header |
| Model | Asynchronous — a `200` means *accepted and queued*, not delivered |
| Coverage | Ethiopian subscribers (Ethio Telecom network) |

Two things about the design that shape how we integrate:

**There is no batch endpoint.** The send endpoint takes exactly one recipient. Sending to N people means N HTTP calls, under an account-wide rate limit. Bulk sending exists only as a dashboard feature (upload a phonebook, run a campaign) — it is not exposed over the API.

**The API key carries the sending identity.** Each key is permanently bound to one campaign, and the campaign supplies the approved Sender ID and the SMS package that gets debited. Nothing in a request body can override either one. To send from a different Sender ID or bill a different package, we need a different key.

---

## 2. Authentication

Pass the API key on every request:

```
KEY: <40-character API key>
```

`API_KEY` is documented as an accepted alias for the same header. Their v1 reference uses `KEY`; the API Keys guide uses `API_KEY`. Either works — pick one and be consistent.

A request with no key header is rejected with `401`.

### Key facts from their API Keys guide

- A key is 40 characters, uppercase letters and digits, generated server-side. Created in **Console → API Keys**, which requires the `ACCOUNT_ADMIN` or `ACCOUNT_OPERATOR` role.
- Creating a key takes three fields: campaign (required), a name (required), optional expiry. **Leave expiry blank and it defaults to 2 years.**
- A key's campaign binding is permanent. Only its name and expiry can be edited afterwards.
- **Expiry does not revoke.** This is the important one: when the expiry date passes, the dashboard labels the key "Expired" (with a warning in the last 7 days) but **requests keep being accepted**. Traffic is never cut off by a forgotten date.
- To actually kill a key, use the **deactivate toggle** (reversible, `401` on the very next request) or **delete** it (permanent). Prefer deactivate.

### Handling implications for us

- Keys live in server-side config or a secret manager only. Never in client-side JS, mobile apps, or a repo — a key cannot be scoped down, it fully controls one campaign's sending.
- Our rotation runbook must use the deactivate toggle, not expiry dates. Setting an expiry and assuming the key dies is a real security gap in this platform.
- If we need separate sending identities (e.g. transactional vs. marketing Sender IDs), that's separate campaigns and therefore separate keys and separate config entries.

---

## 3. Endpoints

Two versions are live. They share the same API keys and the same request body — only the path and the response differ. v1 is fully supported with no announced sunset; v2 is opt-in.

### 3.1 Send SMS — v1

```
POST https://smsethiopia.com/api/sms/send
```

```bash
curl -X POST https://smsethiopia.com/api/sms/send \
  -H "KEY: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"msisdn": "251911639555", "text": "Hello World"}'
```

Response `200 OK`:

```json
{
  "sent": true,
  "id": 0,
  "description": "Accepted for delivery"
}
```

The `id` field is reserved and **always the number `0`** in v1. There is no per-message identifier, which means a v1 send can never be looked up, tracked, or correlated with a delivery report afterwards.

### 3.2 Send SMS — v2 (recommended)

```
POST https://smsethiopia.com/api/v2/sms/send
```

Identical request body to v1. Response `200 OK`:

```json
{
  "sent": true,
  "id": "01JZX5M8Q3T5V0X8YW9RCB2K7D",
  "description": "Accepted for delivery",
  "segments": 1,
  "status": "ACCEPTED"
}
```

| Field | Meaning |
|---|---|
| `sent` | The message was accepted for delivery and queued |
| `id` | Unique, sortable message ID (ULID). **Store this** — it's the only handle to the message |
| `description` | Human-readable status |
| `segments` | How many SMS segments were deducted from the package (see §5) |
| `status` | Initial state, `ACCEPTED` |

### 3.3 Request body (both versions)

| Field | Required | Type | Rules |
|---|---|---|---|
| `msisdn` | yes | string | Must start with `2519` and be **exactly 12 digits**, e.g. `251911234567` |
| `text` | yes | string | Message body. Length rules in §5 |
| `messageType` | no | string | Defaults to `"simple"` |

Note the MSISDN format: international, no `+`, no leading `0`. Numbers stored locally as `0911639555` or `+251911639555` must be normalized to `251911639555` before sending, or the gateway returns error `10000`.

### 3.4 Message status lookup — v2 only

```
GET https://smsethiopia.com/api/v2/sms/{id}
```

```json
{
  "id": "01JZX5M8Q3T5V0X8YW9RCB2K7D",
  "resourceId": 1042,
  "msisdn": "251911639555",
  "segments": 1,
  "status": "DELIVERED",
  "createdAt": "2026-07-18T09:30:12"
}
```

Status lifecycle:

| Status | Meaning |
|---|---|
| `ACCEPTED` | Queued for delivery (what the send call returns) |
| `SENT` | Submitted to the Ethio Telecom network |
| `DELIVERED` | Handset confirmed delivery — all segments, for multi-part messages |

Two behaviours to code around:

- **IDs from other campaigns return `404`.** The API never confirms whether a foreign ID exists, so `404` means "not found *or* not ours" — we can't distinguish, and don't need to.
- **Messages sent before their status upgrade rolled out stay `ACCEPTED` permanently.** Only newer sends carry the correlation ID that powers live status. Any poller needs an attempt ceiling or an age cutoff, otherwise it chases those messages forever.
- `createdAt` has **no timezone suffix** — it's `2026-07-18T09:30:12`, not RFC 3339. Our date parser needs to handle that (the webhook payload, confusingly, *does* use a `Z` suffix).

### 3.5 Delivery report webhook

A **paid add-on**: +15 ETB per package, enabled per campaign. There's no self-service toggle yet — support has to turn it on and register the URL.

When a v2 message is confirmed delivered, they POST to our URL:

```json
{
  "id": "01JZX5M8Q3T5V0X8YW9RCB2K7D",
  "msisdn": "251911639555",
  "status": "DELIVERED",
  "timestamp": "2026-07-18T09:30:12Z"
}
```

| | |
|---|---|
| Retries | 3 attempts — 1s, then 5s backoff |
| Timeout | 5 seconds per attempt |
| Events | `DELIVERED` fires today. **Failure events are planned, not live** |
| Fallback | If our endpoint stays unreachable, reconcile any time with `GET /api/v2/sms/{id}` |

Our endpoint must answer inside 5 seconds and be idempotent — a retried report will arrive more than once.

---

## 4. Errors

Three different response shapes. Any error handling we write has to cover all three.

### 4.1 Business errors — HTTP 400, code embedded in prose

```json
{
  "error_message": "You don't have enough package to send sms please contact with system Administrator. Error Code :: 10005"
}
```

The code is inside the string, not a separate field. Same codes for v1 and v2.

| Code | Meaning | Fix |
|---|---|---|
| `10000` | Invalid MSISDN | Must start with `2519`, exactly 12 digits |
| `10002` | Campaign not activated | The campaign behind the key isn't active — contact support |
| `10005` | Insufficient SMS balance | Package has fewer SMS left than this message's segment count. Renew or upgrade |
| `10006` | Sender ID not approved | Approval goes through Ethio Telecom — see their Sender IDs guide |
| `10007` | Recipient not whitelisted | Free test campaign restriction (see §6). Verify the number, or buy a paid package |

### 4.2 Missing fields — HTTP 400, keyed by field name

Completely different shape, no `error_message`, no code:

```json
{
  "msisdn": "msisdn is mandatory",
  "text": "text is mandatory"
}
```

### 4.3 HTTP-level failures

| Status | Meaning |
|---|---|
| `401` | Key missing from the header, invalid, or deactivated in the console |
| `404` | Unknown endpoint path, or (v2) a message ID not belonging to our campaign |
| `429` | Rate limit exceeded — back off and retry |
| `500` | Server error. Their team is alerted automatically; retry later |

### 4.4 What to retry

Only `429` and `5xx` are transient. **Never retry a `400`** — the same request will fail identically, and blind retries on business errors risk double-sends when the failure was ambiguous. `401` needs a config fix, not a retry.

---

## 5. Message length and segment cost

This is the part most likely to cost us money unexpectedly. **Every segment is deducted from the package separately.**

| Encoding | Single SMS | Per segment when split |
|---|---|---|
| GSM (Latin) | 160 characters | 153 |
| Unicode (Amharic and others) | **70 characters** | **67** |

**A single non-GSM character forces the entire message to Unicode.** Amharic is Unicode, so an Amharic notification holds 70 characters, not 160. A template that fits in one SMS in English can cost four segments in Amharic — same message, 4× the package drain.

Practical consequences for our integration:

- Measure segment cost before sending, especially for anything templated. A rendering bug that appends debug output or repeats a block quietly multiplies our bill.
- Bilingual templates need their limits computed per language, not once.
- On v2, the response `segments` field is the gateway's authoritative count — log it and reconcile against expectations.
- Emoji are Unicode too, and each one counts as two units.

---

## 6. Rate limits and throughput

- Limits are enforced **per account at the gateway** — every API key under the account shares one budget, and v1 + v2 traffic counts together. Adding keys does not add throughput.
- Exceeding it returns `429`. Back off and retry.
- Responses carry `X-RateLimit-Remaining` and `X-RateLimit-Limit`. Read them rather than guessing — the docs don't publish the numeric limit.
- For high-volume campaigns their docs say to contact support to discuss throughput.

Since there's no batch endpoint, any fan-out (a broadcast, a nightly reminder run) is our own worker pool. Size it against the account limit, not per key, and treat `X-RateLimit-Remaining` as the signal to slow down.

---

## 7. Free test campaign — the development gotcha

A new account gets 100 free test SMS and a ready-made test campaign. The sign-up phone number is auto-verified as a test recipient.

**On a free test campaign, messages deliver only to numbers verified in the dashboard.** Every other recipient returns `10007`. During development this looks like the integration is broken when it's working correctly.

Options: verify each test number in the dashboard, or move to a paid package — no whitelist applies to paid campaigns.

---

## 8. Going to production

Their documented path, in the order things block:

1. **Buy a paid campaign / package.** Lifts the whitelist restriction.
2. **Register a Sender ID and get it approved.** Approval is handled with Ethio Telecom. Until it lands, sends fail with `10006`.
3. **Create a production API key** scoped to that campaign (Console → API Keys).
4. **Integrate against v2** — see the recommendation below.
5. **Monitor** via SMS Logs in the dashboard and, if we pay for it, the delivery webhook.

---

## 9. Integration recommendations

### Use v2

The migration cost is one path change; the request body and auth are unchanged. What we get:

| | v1 | v2 |
|---|---|---|
| Endpoint | `/api/sms/send` | `/api/v2/sms/send` |
| Auth | `KEY` header | unchanged |
| Request body | `msisdn`, `text`, `messageType?` | unchanged |
| `id` in response | number, always `0` | string ULID (real message ID) |
| New fields | — | `segments`, `status` |
| Status lookup | — | `GET /api/v2/sms/{id}` |

Without a real message ID we can never answer "did that OTP actually arrive?" — v1 makes delivery unobservable by design.

**Breaking change when migrating:** `id` changes from a **number** to a **string**. Any client parsing it as numeric must be updated. Their docs flag this as the reason v2 is a separate opt-in version.

### Persist the message ID

The ULID is the only handle to a message. Store it on the record that triggered the notification (order, OTP session, job) at send time. Lose it and the message becomes permanently unobservable.

### Poll as the source of truth, treat the webhook as an optimization

The webhook costs extra, needs support to enable, and currently fires only on success — so a message that fails produces no callback at all. Their own docs point at `GET /api/v2/sms/{id}` for reconciliation. A background reconciler over non-final messages is the reliable mechanism; the webhook just makes the happy path faster if we buy it.

Remember the attempt ceiling from §3.4 — older messages never leave `ACCEPTED`.

### Normalize numbers at the boundary

Convert to `251XXXXXXXXX` where numbers enter our system, not at the send call. Local formats (`0911...`, `+251911...`, spaced, hyphenated) all need to collapse to 12 digits starting `2519`. Validating locally also saves a wasted API call on every malformed number.

### Don't trust the webhook payload as-is

There's no documented signature or HMAC on the callback, so anyone who learns the URL can POST a `DELIVERED` for any ID. Two defences are available:

1. A secret token in the URL or a header that we choose — our own measure, not part of their API.
2. Confirm the reported ID against `GET /api/v2/sms/{id}`, which only answers for our own campaign's messages. This is the only authoritative check available.

### Treat "sent" as "accepted"

`{"sent": true}` means queued. Delivery typically completes in under a second per their docs, but any UX that claims "message delivered" needs the `DELIVERED` status, not the send response.

---

## 10. Quick reference

```
Base URL     https://smsethiopia.com/api/
Auth header  KEY: <40-char key>          (alias: API_KEY)

POST /api/sms/send        v1 send    -> {sent, id:0, description}
POST /api/v2/sms/send     v2 send    -> {sent, id:ULID, description, segments, status}
GET  /api/v2/sms/{id}     v2 status  -> {id, resourceId, msisdn, segments, status, createdAt}

Body   {"msisdn":"2519XXXXXXXX","text":"...","messageType":"simple"}
       msisdn: starts 2519, exactly 12 digits

Length  GSM 160 / 153 per segment    Unicode (Amharic) 70 / 67 per segment
Codes   10000 bad number  10002 campaign inactive  10005 no balance
        10006 sender ID unapproved   10007 not whitelisted (test campaign)
HTTP    401 key  404 unknown/not ours  429 rate limit (per account)  500 server
Retry   429 and 5xx only. Never retry 400.
```

---

## 11. What their docs do not specify

Flagged so we don't build on assumptions:

- **No per-SMS price** appears in the API reference. Cost is expressed in segments against a package; the only figure published is the webhook add-on at +15 ETB per package. Any ETB budgeting needs pricing from their campaign/package pages or from support.
- **No numeric rate limit.** Read `X-RateLimit-Limit` at runtime rather than hardcoding a value.
- **No `Retry-After` behaviour documented** for `429`. Honour the header if it appears; otherwise use exponential backoff with jitter.
- **No webhook signature or HMAC** — see §9 for the two available defences.
- **No batch/bulk endpoint** over the API. Bulk is dashboard-only.
- **No documented v1 sunset date.** v1 is described as fully supported, and migration is stated as opt-in whenever we're ready.
- **No idempotency key.** Retrying an ambiguous send can double-deliver, so deduplication has to be ours: track our own correlation key and check it before sending.

---

*Sources: SMSEthiopia API Reference — "Send your first SMS", "SMS API v1 (Live)", "SMS API v2 (Live)", "Error Codes", and the "API Keys" guide, at https://smsethiopia.com/#/api-reference (read 18 Aug 2026).*
