# Dental pricing — review of the draft, and what I would sell instead

**25 Aug 2026 · internal.** Every number below is measured from the live database, not
assumed.

## The draft

| | Patients | Storage | Branches | Price |
|---|---|---|---|---|
| Starter | 200 | 5 GB | 1 | 4,000 |
| Business | 1,000 | 10 GB | 1 | 5,000 |
| Pro | Unlimited | 20 GB | 2 | 10,000 |
| Enterprise | Unlimited | 40 GB | 3 | 15,000 |
| Custom | — | — | — | — |

Add-ons: 500 patients = 500 ETB/mo · 5 GB = 500 ETB/mo

## What the live data says

Cure Dental, the only real customer, live since 15 July 2026:

| Measured | Value |
|---|---|
| Patients | **613** |
| Active staff logins | 3 — one owner, one receptionist/cashier, one dentist |
| Branches | 1 |
| Files stored | 31 files, **2.99 MB** |
| Payments recorded, August | **106,033 ETB** (42 payments) |
| Average treatment course | **14,361 ETB** (max 50,000) |
| SMS sent | 60 |
| Verify.ET checks used | 12 |
| Current plan | **Dental Basic, 4,999 ETB** |
| Whole platform database, all 8 tenants | 20 MB |

## Seven problems with the draft

**1. Starter is unsellable. The cap is below what a clinic has on day one.**
Cure Dental had 613 patients immediately, because they imported their paper register —
using the CSV importer we built specifically to win them. A 200-patient cap means the
first action every new customer takes breaks their plan. They must either not import
(destroying the lock-in that import creates) or buy an add-on before they have seen any
value.

**2. Storage is the wrong meter. It is free, and nobody will ever consume it.**
2.99 MB after six weeks and 613 patients. R2 costs about 2 ETB per GB per month, so
5 GB costs us roughly 10 ETB. Even a clinic taking five compressed X-rays per patient
per year across 1,000 patients uses ~2.5 GB a year — 20 GB is eight years of heavy use.
Charging 500 ETB for 5 GB is a 98% margin on something that will never sell, and worse:

**3. Three of the four rungs are differentiated by something the buyer cannot feel.**
5 → 10 → 20 → 40 GB means nothing to a dentist who has used 3 MB. Nobody upgrades to
get storage they are not short of. The ladder has no upward pressure in it.

**4. The 10,000 → 15,000 step buys nothing anyone wants.** Enterprise is Pro plus
storage nobody uses plus a third branch. Every tenant in the database has exactly one
branch. You would sell approximately none of these, so the tier's only real function is
to make Pro look cheap — and it is not convincing enough to do even that.

**5. Patient count is a hostile meter for a medical record.**
A patient record is permanent history. The number only rises, and it rises with time as
much as with activity. So the bill grows while nothing new is delivered, which reads to
the customer as a penalty for having been a customer. It also creates an incentive to
stop recording patients or to delete them — the exact behaviour that destroys both the
product's value and their clinical record. Any meter that punishes entering data is a
meter that gets you less data.

**6. It ignores the only inputs that actually cost us money.** Storage and patients are
free; SMS and Verify.ET checks are not. The draft does not mention SMS at all, and the
plans currently in the database bundle 2,000 a month for nothing.

**7. It is a 20% price cut on the entry plan, unasked.** Dental Basic is configured at
4,999 today and both dental tenants are on it. The draft's Starter is 4,000.

## The thing the draft misses completely

Cure Dental is on the 4,999 entry plan and is **already using the premium features** —
12 payment verifications and 60 SMS. The differentiators are being given away with the
cheapest plan. That, not the storage ladder, is where the money is.

So: tier on **what the features do for the clinic's money**, not on capacity. Capacity
is free and invisible; capability is neither.

## What I would sell

Unlimited patients, records and X-rays on every plan. They cost 20 MB.

| | **Chair** | **Practice** ★ | **Group** | Custom |
|---|---|---|---|---|
| For | one dentist, off paper | a working practice | 2–3 locations | hospitals, chains |
| Patients & records | Unlimited | Unlimited | Unlimited | — |
| X-rays & images | Unlimited | Unlimited | Unlimited | — |
| Tooth chart, treatment plans, instalments | ✓ | ✓ | ✓ | — |
| Appointments, reception, cashier, receipts | ✓ | ✓ | ✓ | — |
| Daily close & Z-report | ✓ | ✓ | ✓ | — |
| SMS reminders, recalls & payment chase | — | ✓ | ✓ | — |
| Bank & wallet payment verification | — | ✓ | ✓ | — |
| Unbilled-treatment recovery report | — | ✓ | ✓ | — |
| Lab & pharmacy/inventory | — | ✓ | ✓ | — |
| Full finance dashboard & ageing | — | ✓ | ✓ | — |
| Ministry (DHIS2) reporting, AI assist | — | — | ✓ | — |
| Branches | 1 | 1 | 3 | — |
| Staff logins | 5 | 15 | Unlimited | — |
| SMS included / month | 300 | 2,000 | 6,000 | — |
| **Price / month** | **4,000** | **7,000** | **13,000** | Talk to us |

Add-ons: extra branch 2,500/mo · extra 1,000 SMS 350/mo · onboarding and register
import 5,000 one-off, waived on annual.
**Annual: pay for 10 months, get 12.**

## Why this is better

- **Every rung is felt.** You upgrade to get paid faster and to stop losing billable
  work, not to get gigabytes. That is a reason a dentist will act on.
- **Nothing punishes recording data.** Import your whole register, take every X-ray,
  keep twenty years of history — the price does not move. The system gets more valuable
  to them and harder to leave, which is the point.
- **It charges for the two things that cost us money** (SMS, verification) and gives
  away the two that do not (patients, storage).
- **ARPU goes up.** On a plausible mix of ten dental clinics — three Chair, six
  Practice, one Group — this is 67,000 ETB/month against the draft's 52,000: **+29%**,
  with a cheaper, more honest entry point.
- **It prices against value, not cost.** Practice at 7,000 is 6.6% of Cure Dental's
  recorded August revenue, and less than half a receptionist's salary in Addis. One
  recovered 14,361 ETB course pays for two months. That is the sales line.

## Two cautions

1. **Cure Dental is on 4,999 and Practice is 7,000.** Do not just raise it. Grandfather
   them at 4,999 for twelve months and tell them why they are being protected, or move
   them at renewal with the new capability as the reason. Your first reference customer
   is worth more than 2,000 ETB a month.
2. **Never price on revenue processed**, even though we have the data and it would
   align beautifully with value. It is the patient-cap mistake in a worse form: it
   makes under-recording profitable for the customer, and under-recording is the one
   thing that makes this product useless.

## What is not decided

- Whether Practice belongs at 6,500 or 7,500. I picked 7,000; it is worth testing
  against the next three prospects before it is fixed.
- Whether AI assist and DHIS2 should be Group-only or a paid add-on to Practice. They
  cost us per use, so an add-on may be the better shape.
