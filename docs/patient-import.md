# Importing an old patient register (bulk CSV)

For clinics moving off a paper book or an Excel sheet. It loads **patient master
data only** — names, phones, sex, age and the date they were first seen. Money,
balances, treatment notes and anything else in the sheet are ignored.

Where: **Patients → Import old records → Bulk import (CSV)**.
Who: any user with the `patient.create` permission.

---

## 1. What your file needs

One row per line, with a header row. Export from Excel as **CSV (Comma delimited)**.

Columns are matched by heading, in any order — a legacy sheet usually needs no
editing at all. These headings are recognised automatically:

| Patient field | Headings we recognise | Required |
|---|---|---|
| Name | `Name`, `Patient Name`, `Full Name`, `Patient` | **Yes** |
| Phone | `Phone Number`, `Phone`, `Mobile`, `Tel`, `Contact` | No |
| Sex | `Sex`, `Gender` | No |
| Age | `Age`, `Years` | **Yes** (see note) |
| Date of visit | `Date of Visit`, `Visit Date`, `Date`, `Registration Date` | No |
| Card ID | `Card ID`, `File Number`, `Patient Number`, `MRN` | No |

Anything else — `NUMBER`, `Patient History`, `Total Payment`, `Payment Received`,
`Remaining Balance`, `Notes`, any financial column — is **ignored**. You don't
have to delete those columns; leave the sheet as it is.

If a heading isn't recognised, the **Column mapping** panel lets you point each
field at the right column yourself. It also lists exactly which columns are
being ignored, so you can confirm nothing important is being dropped.

### Example

```csv
NUMBER,Date of Visit,Name,Phone Number,Sex,Age,Patient History,Total Payment,Remaining Balance
1,13/06/2017,Abebe Kebede,0911223344,M,34,Tonsillitis,500,0
2,42922,Almaz Tesfaye Bekele,+251912345678,Female,27,Follow-up,300,100
3,2017-06-13,Yohannes Girma,0912 34 56 78,male,8,,150,0
```

Only the bold-mapped columns are read; `NUMBER`, `Patient History`,
`Total Payment` and `Remaining Balance` are skipped.

---

## 2. How the data is cleaned

Done on the server, so every clinic's quirks are handled the same way.

- **Names** — trimmed, extra spaces collapsed, capitalisation normalised
  (`ABEBE KEBEDE` → `Abebe Kebede`, `mary-jane o'brien` → `Mary-Jane O'Brien`).
  A single name goes in as the given name; `First Last` becomes first + last;
  three or more parts become first + middle + last.
- **Phone numbers** — punctuation and spaces removed, Ethiopian numbers folded to
  local form so they compare equal: `+251911223344`, `251911223344`,
  `0911 22 33 44` and `911223344` all become `0911223344`. Other countries keep a
  `+` and their country code.
- **Sex** — `Male`, `M`, `male` → Male; `Female`, `F`, `female` → Female. Blank
  becomes *Unknown* (imported, and counted in the report). Anything else fails
  the row rather than being guessed.
- **Dates** — auto-detected, no need to reformat the sheet. All of these are
  understood, in either calendar:

  | Written as | |
  |---|---|
  | `13/6/17`, `13-6-17`, `13\6\17`, `13.6.17` | short form — day / month / 2-digit year |
  | `13/06/2017`, `13-06-2017`, `13\06\2017` | day / month / full year |
  | `2017-06-13` | year-month-day |
  | `42922` | Excel serial number |

  The short form is the most common in old registers, and reads identically to the
  long one: **`13/6/17` = `13/06/2017`**. A 2-digit year of 50 or below is this
  century (`17` → 2017), above 50 the last one (`98` → 1998).

  Day-first is assumed when a date could be read either way (`06/07/2017` is the
  6th of month 7, not the 7th of month 6) — the usual Ethiopian and European
  convention.

### Which calendar is your sheet in?

**Ethiopian (ዓ.ም) is the default**, since that's how local registers are kept.
The importer converts to Gregorian for storage, so the rest of ClinicOS shows the
date correctly (and still displays the Ethiopian date alongside it).

Set this with **"Dates in my file are"** on the mapping panel. It shows a live
preview using the first real date in your file — for example
`"13/06/2017" → 20 Feb 2025` in Ethiopian, or `→ 13 Jun 2017` in Gregorian.
**Check that preview before importing**: picking the wrong calendar shifts every
date by about 7½ years.

Ethiopian dates are validated properly: 13 months, 30 days per month, and Pagumē
(month 13) limited to 5 days — or 6 in a leap year. `31/06/2017` is rejected as an
Ethiopian date because no Ethiopian month has 31 days.

Excel serial numbers are stored by Excel as Gregorian internally, but the numbers
your staff typed were Ethiopian — so the importer takes the serial apart and reads
its year/month/day in whichever calendar you selected. The behaviour is consistent
either way.

### Age and date of birth — please read

ClinicOS stores a **date of birth**; old registers record an **age**. So the
importer derives one: **1 January of the implied birth year**, worked out from
the age *as at the visit date* — and from the **converted** date, so an Ethiopian
sheet gives the right answer (age 30 on 13/06/2017 EC = 20 Feb 2025 → born 1995).
That is far more accurate than counting back from today.

Every such patient is flagged **estimated birthdate**, and the report tells you
how many. Confirm the real date at the patient's next visit before relying on it
for age-sensitive dosing.

Because a birth year is required, **a row with no age (and no birthdate) fails**.
Those rows come back in the failed-rows file so you can fill the age in and
re-upload just them.

---

## 3. Duplicates

Legacy sheets usually have **one row per visit**, so the same patient appears many
times. Each row is checked against patients already on file, in this order:

1. **Phone number** — exact match after normalisation.
2. **Name + age** — same first and last name, birth year within a year.
3. **Very similar name + matching age** — catches typos (`Kebedde` vs `Kebede`),
   but only when the age also agrees.

You choose what happens on a match:

- **Skip them (recommended)** — the existing record is left untouched and the row
  is counted as a duplicate. Best for a first import: repeated visit rows collapse
  into one patient, and nothing already in ClinicOS gets overwritten by older data.
- **Update their details from this file** — refreshes name, phone and sex, and
  keeps the *earliest* date of visit. Use when the spreadsheet is more current
  than what's in the system.

---

## 4. Check before you import (dry run)

**Check file** validates the whole file and reports exactly what would happen —
importable rows, duplicates and failures — **without saving anything**. Run it
first, fix what it flags, then Import.

---

## 5. The report

After either run you get:

- Total rows, imported, updated, already on file, failed, and the success rate.
- How many rows had no phone, no sex, and an estimated birthdate.
- **Download failed rows** — a CSV of only the rows that failed, with the reason:

  ```csv
  OriginalRowNumber,Name,PhoneNumber,Gender,Age,DateOfVisit,FailureReason
  25,John Doe,ABC123,M,40,13/06/2017,Invalid phone number format
  37,,5551234567,F,29,13/06/2017,Missing patient name
  ```

  Fix the values in that file and upload it again — it has the headings the
  importer expects, so it re-imports as-is. Only the failed rows are retried.
- **Download full report** — every row with its outcome and new card ID.

Failure reasons you may see: missing patient name · invalid phone number format ·
invalid gender value · invalid age · missing age · invalid date format in Date of
Visit · date of visit is in the future · card ID already used by another patient ·
patient limit reached for your plan.

---

## 6. What the import guarantees

- **A bad row never stops the run.** Each row is validated and saved in its own
  transaction; a failure is recorded and the importer moves to the next row.
  Rows already imported are never rolled back.
- **Large files are safe.** The file is sent in batches of 300 rows, so memory
  stays flat whether you import 50 patients or 5,000. Progress is shown as it goes.
- **Card IDs are preserved.** Map the Card ID column and each patient keeps their
  existing number; leave it unmapped and ClinicOS assigns `P000001`, `P000002`, …
  A card ID already in use fails that row instead of silently reassigning it.
- **The original registration date is kept.** Date of Visit is stored as the
  patient's **first visit date**, separate from when the record was created in
  ClinicOS — so your history stays truthful.

---

## 7. Re-running an import

Safe to repeat. With **Skip**, rows already imported are recognised and counted as
duplicates rather than creating second copies — so if an import is interrupted,
just run the same file again.
