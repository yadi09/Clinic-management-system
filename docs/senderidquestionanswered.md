# Open question: can each clinic have its own sender ID?

**The question from the plan:** with a shared account, patients see a generic sender. Is a per-account sender ID available, or does the clinic name have to lead every message?

**Status: answered by SMSEthiopia's own docs — no need to ask them.** The answer is better than per-account.

---

## Answer

**Sender IDs are per *campaign*, not per account.** A campaign bundles one prepaid package + one sender ID + its API keys + its own SMS balance. One account can hold many campaigns.

So under the single shared account, **each clinic gets its own campaign with its own approved sender name** — patients see the clinic, not a generic sender. The clinic name no longer has to lead the message body.

The generic sender you're seeing now is **8726**, a shared numeric sender pre-approved on the Default campaign only. Default campaigns deliver only to numbers verified in the dashboard, so it was never viable for patients regardless.

## How to get one

1. Console → **Sender ID** → *New Sender Name*. Status starts `PENDING`.
2. A platform admin registers it with Ethio Telecom. Nothing for us to do here.
3. Status turns `APPROVED` → campaigns using that name can send.

Typically **1–2 business days**, but the decision rests with Ethio Telecom and `REJECTED` is a real outcome. While `PENDING`, every send through that campaign fails with error `10006` — their docs say retry later, don't resubmit the message.

## What it costs us

| | |
|---|---|
| Per clinic | Its own campaign, so its own package purchase from the shared deposit |
| Balances | **Do not pool.** One clinic running out (`10005`) doesn't touch another's credits — but no shared buffer either |
| Renewals | **Manual today** (auto-renew "coming soon"), so N clinics = N deadlines. Unused SMS carry over, so early renewal is free |
| Add-ons | Priced per package — delivery webhook (+15 ETB) multiplies per clinic |
| Onboarding | A new clinic can't send until its sender ID clears approval. Build the lead time into onboarding |

## One caveat worth knowing

**Roles are org-wide; there is no per-campaign access isolation.** Anyone with the Operator role can send through *any* campaign and read *all* message logs, including other clinics'. Campaign separation gives us distinct sender IDs and separate balances — not tenant isolation.

If clinics ever need real isolation, that means separate accounts. Note the trap: accepting an invitation *moves* a user out of their current organization and they lose access to their old data.

## Still worth asking support

Their docs don't cover these. Contact: support@smsethiopia.com

1. **Can one approved sender name attach to multiple campaigns**, or does each campaign need its own approval? Decides whether a single group-level sender is possible.
2. **Do they require supporting documents to approve a sender name representing a third party** — a clinic that isn't the account holder? This is the real risk for the multi-clinic model, and the question to lead with.
3. **Format rules** for a custom sender name — length and allowed characters are documented nowhere.
4. **Package prices**, which appear only in the in-console picker.

---

*Sources: SMSEthiopia docs — "Sender IDs & Approval", "Campaigns & Packages", "Team & Roles", "Error Codes" (https://smsethiopia.com/#/api-reference, read 18 Aug 2026).*
