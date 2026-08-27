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
| SMS / month | 300 | 2,000 | 6,000 | Agreed |
| Tooth chart, plans, instalments | ✓ | ✓ | ✓ | ✓ |
| Appointments, reception, cashier | ✓ | ✓ | ✓ | ✓ |
| Daily close & Z-report | ✓ | ✓ | ✓ | ✓ |
| SMS reminders, recalls, payment chase | — | ✓ | ✓ | ✓ |
| Bank & wallet payment verification | — | ✓ | ✓ | ✓ |
| Unbilled-treatment recovery | — | ✓ | ✓ | ✓ |
| Lab & pharmacy / inventory | — | ✓ | ✓ | ✓ |
| Full finance dashboard & ageing | — | ✓ | ✓ | ✓ |
| Ministry (DHIS2), AI assist | — | — | ✓ | ✓ |
| **ETB / month** | **4,000** | **7,000** | **13,000** | Talk to us |

**Add-ons:** 500 patients 800 · 5 GB 500 · extra branch 2,500 · 1,000 SMS 350 — all per
month. Onboarding and register import 5,000 once, free on annual.
**Annual: pay for 10 months, get 12.**

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

## One config change needed to match the page

`images_per_patient` is currently **100** on Dental Basic, **8** on Dental Pro and
**10** on dental business. The code treats it as unlimited only when it is empty
(`ImagesPerPatient == nil` in `kernel/limits`). To deliver "unlimited X-rays per
patient" as the page now promises, clear that field on all three plans in the
super-admin Plans tab. Nothing else on the page needs code — patient and storage caps
are already enforced.

## Not decided

- Whether Practice belongs at 6,500 or 7,500. I picked 7,000; worth testing against the
  next three prospects before it is fixed.
- Whether AI assist and DHIS2 should be Group-only or a paid add-on to Practice. They
  cost us per use, so an add-on may be the better shape.
