# The patient's Treatments panel

**Status:** design, for approval · 25 Aug 2026

## The problem, from the screenshot

The patient record has four subpages: Timeline, Certificates, Messages, Money. The
Timeline is one date-ordered spine across everything, and it is right for the question
"what is happening to this patient". It is structurally incapable of answering the
other question — **"how is this course going?"** — because a course is not a date, it
is a container, and the spine deliberately dissolves containers.

Here is what that costs, read straight off the current screen:

```
TODAY      treatment Two   visit 2 of 6     3,300 ETB   Paid
NEXT       treatment 4     visit 4 of 20      700 ETB   Not yet due   Aug 26
           Treatment 3     visit 4 of 5     4,000 ETB   Not yet due   Aug 28
           treatment 4     visit 5 of 20      700 ETB   Not yet due   Aug 29
           treatment 4     visit 3 of 20      700 ETB   Not yet due   Aug 31
           treatment 4     visit 6 of 20      700 ETB   Not yet due   Sep 1
```

Four things are invisible here and all four matter:

1. **Visit 3 of "treatment 4" is booked AFTER visits 4 and 5.** The course runs
   4 → 5 → 3 → 6. On a date spine that is five ordinary rows. On a course view it is
   the first thing you see.
2. **There are three live courses and no way to see one.** "treatment 4" has 20 visits;
   four of them appear in this window, mixed with two other courses.
3. **The terms are nowhere in the product.** 20 visits × 700 = 14,000 ETB, every
   *n* weeks, starting when, due by when, for which tooth, from which catalogue price.
   None of that is on any screen today.
4. **Progress is unanswerable.** "visit 2 of 6" is a label on one row, not a position.
   How much of the course is delivered, how much is paid, what is left — three
   different fractions, none of them shown together.

The Money tab does show per-course cards, but only money: paid-of-planned, owed now,
at cashier. No visits, no dates, no terms, no clinical content. So "everything about
this treatment" is currently spread across the cockpit, the Timeline, the Money tab and
nothing at all.

## What this adds

A fifth panel on the record shelf, **Treatments**, sitting directly after Timeline —
the same rail, the same one-panel-at-a-time behaviour, the badge showing how many
courses are live.

It is **course-first**, which is the whole point: the Timeline is time-first and stays
exactly as it is. Nothing is moved or removed.

### Level 1 — the courses

One card per course, ordered active → completed → cancelled, and within active by the
soonest thing that needs attention. Each card answers "how is it going" without being
opened:

| What | Why it is there |
|---|---|
| Title, tooth, catalogue service | Which course this is, in the clinic's own words |
| Status chip — Active / Completed / Cancelled | |
| **Visits bar** — `7 of 20 done`, as segments | Delivery progress. Money progress is a different fraction and is shown separately, because on an instalment course they diverge and one is regularly mistaken for the other |
| **Money line** — `collected of planned`, `owed now`, `with the cashier` | Same numbers and same definitions as the Money tab. One source: the server's per-plan `money` |
| **Next visit** — date, dual Gregorian/Ethiopian, "tomorrow" / "in 3 days" | The one actionable fact |
| **Flags** (below) | What is wrong with this course |

Flags are the reason to build this rather than a prettier list. Each is a real
condition, computed from data already on the page:

- **Out of order** — a visit is booked before an earlier-numbered one. *"visit 3 is
  booked after visit 5."*
- **Stalled** — active course, nothing booked ahead. A 20-visit course with no next
  visit has quietly stopped, and today nothing says so.
- **Missed** — visits whose date has passed and were never recorded.
- **Unbilled** — work delivered on this course with no charge behind it, and an unpaid
  deposit. Reuses the existing shared definition, so this can never disagree with the
  Money tab or the Unbilled treatment report.
- **Past its deadline** — remaining visits are scheduled beyond the course's own
  deadline, or the deadline has passed with visits outstanding.

### Level 2 — one course

Tapping a card opens that course, in place, with a back link. Five blocks:

**1. Header** — title, tooth, status, and the actions that have no other home:
edit title/tooth/note, add a visit, finish the course. Permission-gated
(`dental.manage`); the desk sees the same page read-only.

**2. Terms** — the contract, printed plainly for the first time:

```
Total agreed      14,000 ETB          Started      12 Aug 2026 · 6 Nehase 2018
Per visit            700 ETB × 20     Every        2 weeks
From the list     Root canal therapy  Due by       30 Nov 2026 · 21 Hedar 2019
                  listed at 15,000 ETB
Note              upper left quadrant, patient prefers mornings
```

The list price is shown next to the agreed total on purpose: a course agreed at 14,000
against a 15,000 list price is a 1,000 ETB discount that nobody can currently see.

**3. Money for this course** — planned, collected, with the cashier, written off,
owed now, still to pay; the deposit callout when one is outstanding; and the unbilled
rows with their existing "Send to cashier" button. All from the shared components the
Money tab uses, not reimplemented.

**4. Visits** — the course's own sequence, **in visit order**, which is the view that
makes the out-of-order booking obvious:

```
✓  1   12 Aug 2026 · 6 Nehase    700 ETB  Paid          Access opening · #26
✓  2   19 Aug 2026 · 13 Nehase   700 ETB  Paid          + 1 image
●  3   31 Aug 2026 · 25 Nehase   700 ETB  Not yet due   ⚠ booked after visit 5
○  4   26 Aug 2026 · 20 Nehase   700 ETB  Not yet due
○  5   29 Aug 2026 · 23 Nehase   700 ETB  Not yet due
```

Each row: number, date (dual), amount, payment state in the shared vocabulary, the
procedure and tooth when recorded, and quiet markers for what is attached — notes, a
prescription, images, an extra procedure taken at that visit. Tapping a row opens that
visit in the cockpit above, the same as the Timeline does, so there is one editor.

**5. Evidence** — the images and prescriptions belonging to this course, gathered in
one place. Today they are reachable only by opening each visit.

## What it deliberately does not do

- **It is not an editor of visits.** The cockpit above is where a visit is recorded;
  making a second editable surface is how a clinician reviewing history overwrites it.
  Rows link to the cockpit.
- **It does not restate the patient's total balance.** That is the Money tab's
  headline. This panel is per course.
- **It does not compute money.** Every figure comes from the server's per-plan
  projection and the shared `owedOnPlan` helper. A second definition of "owed" is how
  a clinic gets two different answers on one screen.
- **It does not appear for non-dental clinics.** Same gate as the rest of the dental
  workspace.

## Shape and behaviour

- One column, list → detail with a back link, on every width. A two-pane master/detail
  at `xl` was considered and rejected for now: the panel sits inside the record shelf
  under the cockpit, and a 320px detail column there is worse than a full-width one.
- Mobile follows the shipped conventions: `touch-hit` targets, cards not tables, the
  visits list scrolling inside its own container rather than the page.
- Empty state: a patient with no courses gets one line and the New treatment action,
  not an empty frame.
- The chosen course is remembered per patient for the session, like the shelf panel
  itself — coming back from the cashier should not lose your place.

## Cost

No backend work. `GET /dental/patients/:id/summary` already returns every plan with its
sessions, extras, deposit, per-plan money, images and prescriptions. This is one new
component reading data the page has already fetched, plus one line to register it on
the shelf.
