# Demo seed — a general clinic with a year behind it

Fills an empty tenant with the data a clinic would have if it had been running for
three months, so a demo never lands on an empty screen. Written for **Joy Speciality**
(`joy-speciality`, a general clinic) and reusable for any other general tenant by
changing the one `\set tid` at the top of each file.

## Running it

Each file is idempotent — every insert is guarded by `NOT EXISTS`, so re-running tops
up rather than duplicating.

```sh
for f in 01-catalogs 02-patients 03-encounters 04-laboratory 05-charges 06-scheduling-and-beds; do
  docker exec -i clinicos-postgres-1 psql -U clinic -d clinic < $f.sql
done
bash 07-admissions.sh     # goes through the API, so admissions are billed for real
```

`07-admissions.sh` creates a temporary `seeder@<tenant>.internal` login, uses it, and
deletes it on exit. It deliberately goes through the HTTP API rather than SQL, because
admitting, transferring and discharging is where the money is computed — seeding those
by hand would produce rows the product itself would never have written.

## What each file lays down

| | |
|---|---|
| **01-catalogs** | 4 more departments, 16 priced services (2 of them defaults, so reception raises a real fee), 15 diagnoses in 8 categories, 6 allergens, 10 lab tests with reference ranges, 12 drugs and the prescribing formulary |
| **02-patients** | 48 patients with Ethiopian names, ages 3–72, phones, addresses, blood groups and first-visit dates spread over a year; allergies on 7 of them |
| **03-encounters** | 285 closed visits over the last 90 days, each with vitals, a signed SOAP note and a primary diagnosis; a prescription on two visits in three |
| **04-laboratory** | 89 orders on one visit in three, a few still in process, the rest validated with results flagged against their own reference ranges |
| **05-charges** | 750 charges — the card fee and consultation on every visit, the investigations that were ordered, the occasional procedure. Most paid on the day with a receipt number, ~20 still at the cashier, a couple waived, and a few old ones never collected so debt ageing has something to age |
| **06-scheduling-and-beds** | 150 appointments across a 29-day window (past ones completed, no-show or cancelled; 72 still to come), 9 patients in today's queue at every stage, 2 wards and 11 beds priced from 450 to 2,500 |
| **07-admissions** | 6 patients currently on the ward including one moved down from ICU, 5 discharged with their stays billed, and one deposit left overdue so the board shows the red state |

## Two things to know

**The appointment slots are deliberately spaced.** `appointments_no_provider_overlap` is
an exclusion constraint, and this tenant has one doctor, so every appointment is
generated into its own 30-minute slot on a working day. Adding more without respecting
that will fail the whole transaction.

**Money is real.** ~160,000 ETB of recorded payments across three months, which is what
makes the finance chart, the debt ageing and the daily close look like a clinic rather
than a fixture. If this tenant later becomes a live customer, the demo data has to come
out first — every row it writes is identifiable (`JOY-` MRNs, and everything else hangs
off those patients).
