# Browser-agent prompt — Verify.ET dashboard

For a browser agent (Claude in Chrome / cloud extension) working on **verify.et** while
signed in as ReiCB. Everything below is a dashboard-only action: our backend cannot do
any of it, because Verify.ET authenticates account management with a **session cookie,
not an API key**.

Re-run the same prompt whenever a clinic adds a new receiving account (§ "Accounts to
register"). Update that list first.

---

## The prompt (copy from here)

```
You are working in my own Verify.ET account (verify.et), signed in as the account
owner. I authorise you to make the changes below on my behalf.

Verify.ET verifies Ethiopian bank and mobile-wallet transaction receipts. My clinic
software calls its API to confirm that a patient's claimed transfer is real, is for
the right amount, and reached the clinic's own account. Everything in this task is a
dashboard action, because account management there cannot be done with an API key.

Work through the steps in order. Do not improvise beyond them.

STEP 1 — Register our receiving accounts
Find the bank accounts / settlement accounts section (the API calls it
/api/bank-accounts; in the dashboard it may be under Settings, Bank accounts,
Business accounts, or Settlement). Register these, creating each only if it is not
already there:

  1. Provider: Telebirr (mobile wallet)   Account/phone: 0988538381
  2. Provider: Commercial Bank of Ethiopia (CBE)   Account: 1000462299366

Enter the account numbers EXACTLY as written, digit for digit. Do not reformat them,
do not strip a leading zero, do not add spaces or dashes. 0988538381 has a leading
zero that matters.

If the form asks for an account-holder name and I have not given you one, stop and
ask me rather than inventing one.

STEP 2 — Read back what the dashboard now shows
List every registered account: provider, the account number as displayed (say if it
is masked, e.g. 2519****8381), and any status such as verified / pending / active.

STEP 3 — Answer these questions from what is actually on screen
Do not guess, and do not answer from general knowledge of similar products. For each,
quote the exact wording you can see, or say "not stated anywhere I could find".

  a) Current plan, and the credit balance remaining. Where is it shown?
  b) Does the free "Starter" tier permit API calls, and how many? (We have no test
     environment, so this decides whether we can develop against anything but
     production.)
  c) Is there any setting for a WEBHOOK SIGNING SECRET? If so, where, and does the
     page say whether the X-Webhook-Timestamp it sends is in seconds or milliseconds?
  d) For CBE verification the API needs an "accountSuffix" of exactly 8 digits.
     Does anything in the dashboard or its help text say WHOSE account that suffix
     belongs to — the payer's or the receiver's? This one matters a lot to me.
  e) Do failed or unverified lookups consume a credit? Quote any wording about it.
  f) Any stated rate limits, per key or per account?

STEP 4 — Report
Give me: what you registered, what was already there, the answers to Step 3, and
anything on those pages that looked important and that I did not ask about.

HARD RULES — do not break these:
- Do NOT create, regenerate, rotate or delete any API key. The full key is shown only
  once at creation and I already have mine; regenerating it would break my live
  system.
- Do NOT copy any API key, secret, token or password into your reply, even partially.
  If you must refer to one, say "the existing key" and give at most its last 4
  characters.
- Do NOT run any test verification, sample request, or "try it" button. There is no
  sandbox: every call spends a real credit from a shared balance my production
  checkout depends on.
- Do NOT change the plan, buy credits, or accept any upgrade prompt.
- Do NOT delete or edit accounts that are already registered. Only add what is
  missing, and tell me what you found.
- If a page asks for something I have not given you, or a step looks different from
  the description above, stop and ask instead of guessing.
```

---

## Accounts to register

Kept here so the prompt stays truthful. Source of truth is `payment_rails` — the
accounts each clinic entered under **Settings → Payment methods**:

```sql
SELECT t.slug, pr.label, pr.bank_key, pr.account_number
  FROM payment_rails pr JOIN tenants t ON t.id = pr.tenant_id
 WHERE pr.bank_key IS NOT NULL AND pr.account_number IS NOT NULL
 ORDER BY t.slug, pr.sort_order;
```

As of 2026-08-23:

| Clinic | Provider | Account |
|---|---|---|
| cure-dental | Telebirr | 0988538381 |
| cure-dental | CBE | 1000462299366 |

## Why registration is belt-and-braces, not strictly required

We always send `settlementAccount` explicitly on every verification, so the receiver
check is scoped to that one account rather than "any account we own". That is
deliberate: with one platform Verify.ET account serving every clinic, the vendor's
saved-account fallback would ask the wrong question and could confirm one clinic's
payment against another clinic's account.

Registering the accounts anyway covers the fallback path, and the vendor's own
getting-started guide says an unregistered account is what produces the
`no_registered_accounts` reason code. It costs nothing and removes a failure mode.
