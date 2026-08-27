# Dental pricing

**Decided 27 Aug 2026.** Metered on the size of the patient book and on storage, per
your call. Every number below is measured from the live database, not assumed.

## The model

You pay for how big your patient book is. A clinic with 3,000 patients on record is
earning more than one with 800, so it pays more — that is the whole logic, and it is
sound: patient volume is the closest thing we can meter to clinic revenue without
asking to see their books.

Two caps: **patients on record** and **storage in GB**. Images per patient are
uncapped, so a dentist never has to choose which X-ray to delete mid-treatment; storage
is what bounds it, and storage can be topped up.

## The price list

| | **Chair** | **Practice** ★ | **Group** | **Custom** |
|---|---|---|---|---|
| Patients on record | 1,000 | 3,000 | 10,000 | Unlimited |
| Storage | 5 GB | 20 GB | 50 GB | As needed |
| X-rays per patient | Unlimited | Unlimited | Unlimited | Unlimited |
| Branches | 1 | 1 | 3 | Unlimited |
| Staff logins | 5 | 15 | Unlimited | Unlimited |
| Records, tooth chart, plans, instalments | ✓ | ✓ | ✓ | ✓ |
| Appointments, reception, queue | ✓ | ✓ | ✓ | ✓ |
| Cashier, receipts, daily close, Z-report | ✓ | ✓ | ✓ | ✓ |
| Certificates & prescriptions | ✓ | ✓ | ✓ | ✓ |
| **Unbilled-treatment report** | — | ✓ | ✓ | ✓ |
| **Payment verification** | — | ✓ | ✓ | ✓ |
| **Finance dashboard, ageing, per-dentist** | — | ✓ | ✓ | ✓ |
| **Patient SMS — reminders, recalls, chase** | — | ✓ | ✓ | ✓ |
| **Recall lists** | — | ✓ | ✓ | ✓ |
| Laboratory | — | ✓ | ✓ | ✓ |
| Pharmacy & inventory | — | ✓ | ✓ | ✓ |
| Ministry (DHIS2) reporting | — | — | ✓ | ✓ |
| AI clinical assist | — | — | ✓ | ✓ |
| Support | Business hours | Priority | Named contact | Named contact |
| **ETB / month** | **4,000** | **7,000** | **13,000** | Talk to us |

### Packages

A clinic that has outgrown one number but is not ready to change plan buys just that
number. Monthly, start and stop at will.

| Package | Adds | ETB / month | Stack up to |
|---|---|---|---|
| +500 patients | 500 more on record | **500** | 2 on Chair · 4 on Practice |
| +5 GB storage | 5 GB for X-rays and documents | **500** | No limit |
| +5 staff logins | five more people who can sign in | **600** | 2 on Chair · no limit above |
| +1 branch | a second location with its own reports | **2,500** | Practice and above |
| AI clinical assist | a second opinion on the recorded visit | **1,500** | Practice · included on Group |
| Patient SMS | reminders, recalls, payment chase | from **0.60** each | Practice and above |
| Setting up & importing your register | one-off | **5,000** once | free on annual |
| Training on site | half a day, one-off | **2,500** once | any plan |

**Annual: pay for 10 months, get 12.**

**Why the patient pack is capped rather than priced high.** At 500 ETB a pack is
1.00 ETB per patient, while the Chair → Practice upgrade is 1.50 — so on price alone a
clinic would stack packs forever, stay on Chair, and never see the features that make
Practice worth having. Raising the pack to 800 fixes the arithmetic but makes the
cheapest thing on the price list look mean. Capping the stack fixes it structurally
instead: two packs takes Chair to 2,000 patients for 5,000 ETB, and the third patient
pack does not exist — the only way past 2,000 is Practice, which brings 3,000 patients
and everything under *Getting paid* with it. The customer keeps a round, friendly 500;
the ladder keeps its pull.

The storage pack is uncapped on purpose: a clinic that genuinely only needs gigabytes
should be able to buy gigabytes without paying for features it will not use. Storage is
not a proxy for anything — it is the one resource here that really is just a resource.

**Patient SMS is sold on usage, not capped** — Practice and above only:

| Credit | ETB | Each |
|---|---|---|
| 500 messages | 450 | 0.90 |
| 2,000 messages | 1,500 | 0.75 |
| 10,000 messages | 6,000 | 0.60 |

Prepaid credit rather than metered post-paid billing, deliberately. Billing usage after
the fact means bill shock and a collection argument every month, in a market where
collecting at all is the hard part; every Ethiopian SMS gateway already works on prepaid
credit, so it is the familiar shape. It still meets the requirement — no cap, they send
as much as they want, they pay for what they send — and it removes our credit risk.
Credit does not expire while subscribed, and the unit price falls with volume so buying
bigger is rational.

One recall that brings back a patient for an average 14,361 ETB course pays for roughly
18,000 messages. That is the line to use when a clinic hesitates.

## What Chair deliberately does not have

Chair has to run a single-dentist practice end to end, and honestly — see the patient,
chart the teeth, plan the treatment, book it, receive them, take the money, close the
till. If it cannot do that it is a trial, not a plan, and a frustrated clinic churns
instead of upgrading. So every gate sits past "run today", and each one maps to money
the clinic is losing right now:

| Held back from Chair | Why it pulls |
|---|---|
| **Unbilled-treatment report** | The strongest gate in the product. It shows work already delivered and never charged for — 5,400 ETB on the test patient alone. Money they are losing today. |
| **Patient SMS, reminders & recalls** | Empty chairs are felt daily, and a recall list is the cheapest revenue in dentistry. |
| **Payment verification** | Felt the first time a patient claims to have transferred and has not. |
| **Finance dashboard, ageing, per-dentist** | Chair keeps the cashier and the daily close — it must be able to close the till. What it does not get is "was this month good", which is the owner's question. |
| **Laboratory, pharmacy & inventory** | Whole modules a solo practice genuinely may not need. |
| **Ministry (DHIS2) reporting** | Group — the compliance surface a multi-site group needs. |
| **AI clinical assist** | Group. It costs us per use, so it belongs where the margin is. |
| **Support: business hours** | Free to give, real perceived value. |

### What I would NOT gate, and why

- **Treatment plans and instalments** — this *is* the dental product. Gating it makes
  Chair pointless and the ladder look mean.
- **The tooth chart and X-ray upload** — core clinical work.
- **The register import** — it is the retention lever, and it is already monetised as a
  5,000 ETB one-off. Charging twice discourages the one thing that makes a clinic hard
  to leave.
- **Access to their own records, or exporting them** — indefensible in healthcare, and
  the kind of term that loses a deal in the room.
- **The audit trail itself** — only how long it is kept.

### The mechanism matters more than the list

A greyed-out menu item persuades nobody. Each locked feature should be visible **with
the number attached, computed from that clinic's own data**:

- "You have **5,400 ETB** of treatment delivered and never billed. See the list on Practice."
- "**23 patients** have not been in for over six months. Practice can text them all today."
- "**4 transfers** this month were never checked against the bank."

That turns a restriction into a quote. It is the highest-leverage thing to build once
the plans are set, and it needs no new data — all three numbers already exist in the
product.

## Why these numbers, and not the draft's

The draft was 200 / 1,000 / unlimited / unlimited patients at 4,000 / 5,000 / 10,000 /
15,000, with 5 / 10 / 20 / 40 GB.

**The entry cap moved from 200 to 1,000.** Cure Dental has **613 patients** and had them
within days, because they imported their paper register with the CSV importer we built
to win them. A 200-patient plan breaks on the first action every new customer takes, so
nobody could ever be sold it. 1,000 gives a new clinic real room and still puts a
growing practice into Practice within a year or two — which is the point of the meter.

**Storage is now sized to the patient cap instead of being its own invented ladder.**
With images uncapped, a dental course runs to roughly 3–5 MB of compressed X-rays per
patient, so 1,000 patients ≈ 5 GB, 3,000 ≈ 20 GB, 10,000 ≈ 50 GB. The tiers now mean
something: they are what that many patients actually need. The draft's 40 GB on
Enterprise was eight years of heavy use for a clinic that had already gone unlimited on
patients, so it was differentiating on nothing.

**The top paid tier has a cap now.** The draft gave Pro and Enterprise both unlimited
patients, which breaks the meter exactly where it should bite hardest: a 40,000-patient
chain paid the same as a 1,100-patient clinic. Group stops at 10,000 and past that it is
Custom, which is also what makes Custom a real tier rather than a placeholder.

**The 10,000 → 15,000 step is gone.** Enterprise was Pro plus storage nobody needed plus
a third branch. Every tenant in the database has exactly one branch. Group at 13,000
carries the branches, the ministry reporting and the AI assist, so the step buys
something a buyer can name.

**Practice went from 5,000 to 7,000, and it is where the money is.** Cure Dental sits on
the 4,999 entry plan and is *already using* payment verification (12 checks) and SMS
(60 sent). The differentiators were being given away with the cheapest plan. Putting
them in Practice is the single biggest change here: on a plausible ten-clinic mix —
three Chair, six Practice, one Group — this is 67,000 ETB/month against the draft's
52,000, **+29%**, with a cheaper entry point than the draft's Starter.

**The patient add-on is 800 per 500, not 500.** At 500 ETB it costs 1.00 ETB per patient
while the Chair → Practice upgrade costs 1.50 ETB per patient, so a clinic needing
headroom would buy add-ons forever and never upgrade — and never see the Practice
features. At 800 (1.60/patient) upgrading always wins on price, and the add-on does what
it should: carry someone over the line until they are ready to move. The storage add-on
stays at your 500 per 5 GB; a clinic that genuinely only needs gigabytes should be able
to buy gigabytes without paying for features it will not use.

## What the live data says

Cure Dental, the only real customer, live since 15 July 2026:

| Measured | Value |
|---|---|
| Patients | **613** |
| Storage used | 31 files, **2.99 MB** |
| Active staff logins | 3 — owner, receptionist/cashier, one dentist |
| Branches | 1 |
| Payments recorded, August | **106,033 ETB** (42 payments) |
| Average treatment course | **14,361 ETB** (max 50,000) |
| SMS sent | 60 |
| Verify.ET checks used | 12 |
| Current plan | **Dental Basic, 4,999 ETB** |
| Whole platform database, all 8 tenants | 20 MB |

Sanity check on the price: Practice at 7,000 is **6.6%** of their recorded August
revenue, and less than half a receptionist's salary in Addis. One recovered 14,361 ETB
course pays for two months. That is the sales line, and it is true.

## Three things to handle

**1. Cure Dental is on 4,999; Practice is 7,000.** Do not simply raise it. Grandfather
them at 4,999 for twelve months and tell them you are protecting them, or move them at
renewal with the new capability as the reason. Your first reference customer is worth
more than 2,000 ETB a month.

**2. The imported register is the one real weakness of a patient cap.** A clinic
arriving with 4,000 old records lands in Group on day one and pays 13,000 before it has
seen any value — and the import is your best retention lever, so you do not want to
discourage it. Two ways out, both cheap: give a one-time import allowance that is not
counted for the first year, or let a clinic **archive** inactive patients (records kept,
readable, not counted toward the cap). Archiving is the better answer, because it keeps
the meter pointed at the *working* book — which is what actually tracks their revenue —
without ever making deleting history profitable. Small feature; say the word.

**3. Never price on revenue processed.** We have the data and it would align perfectly
with value, but it makes under-recording profitable for the customer, and under-recording
is the one thing that makes this product worthless.

## Before this can be sold: what the software does not yet enforce

The caps are real. Most of the feature gates are not, yet — this matters, because
selling a plan the code does not enforce means the gate is fiction.

**Packages are all enforced today** — `patient_limit`, `storage_gb`, `user_limit` and
`branch_limit` are per-tenant overrides (`tenants.*_override`) that already beat the
plan value in `kernel/limits`, so selling a pack is one number in the super-admin
console. The stack caps are a sales rule, not code; if a clinic should never exceed
them, that is worth a small guard later.

**Enforced today, config only:**

| | |
|---|---|
| Patients, storage, branches, staff logins | `kernel/limits` enforces all four. Set the numbers in the Plans tab. |
| X-rays per patient | Clear `images_per_patient` — it is **100** on Dental Basic, **8** on Dental Pro, **10** on dental business, and the code treats it as unlimited only when empty. |
| SMS on/off and volume | `sms_monthly` is a per-calendar-month cap. Set Chair's to 0 and it is off. |
| Laboratory | Already flag-gated in the UI (`flagOn("laboratory")`). |

**Needs building — one to two days:**

| Gate | What is missing |
|---|---|
| Payment verification | Config-gated globally by `VERIFYET_API_KEY`, not per plan. |
| Unbilled-treatment report | Permission-gated only (`payment.charge` / `dental.manage`). |
| Finance dashboard | Permission-gated only (`billing.manage`). |
| Patient SMS as a feature | Only the monthly count is capped; the surface itself is not gated. |
| Ministry (DHIS2) reporting | Config-gated by `DHIS2_TOKEN`, not per plan. |
| AI clinical assist | Config-gated by `NVIDIA_API_KEY`, not per plan. |
| Pharmacy & inventory | The flag exists but nothing reads it — permission-gated in practice. |

The work is the same shape each time: widen the `feature_flags` CHECK constraint to add
the new flags (same migration pattern as 00031 and 00034), map them in the plan preset
in `provision.go` — which already inserts flags with `source='plan'` — hide the surface
with `flagOn(...)` in the frontend, and add a `RequireFeature` middleware on the
server. That middleware does not exist: **feature flags are currently written and read
but never enforced server-side**, so today they are UI hints, not boundaries.

**Dropped from the ladder: audit-history retention.** `audit_retention_days` is written
at provisioning and never read again — there is no pruning job, so every plan keeps
everything forever and the 6-month / 2-year / 5-year difference would have been
fiction. It is also the wrong lever: deleting a clinic's audit history to enforce a
price tier is indefensible in healthcare, and probably against Ethiopian record-keeping
rules. The page now just says every change is recorded, on every plan, which is true.

**SMS credit needs a wallet.** Today the code enforces a monthly count. Prepaid credit
that carries over needs a balance plus top-ups. Until then, sell the credit as a monthly
bundle using the existing cap — it works with zero code and the customer experience is
nearly identical.

## Not decided

- Whether Practice belongs at 6,500 or 7,500. I picked 7,000; worth testing against the
  next three prospects before it is fixed.
- Whether AI assist and DHIS2 should be Group-only or a paid add-on to Practice. They
  cost us per use, so an add-on may be the better shape.
