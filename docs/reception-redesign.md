# Design — Reception, redesigned

Status: **proposed, awaiting approval** · 23 Aug 2026
Nothing here is built yet. Every claim about current behaviour was read from the code
and is cited, so you can check any of it before approving.

---

## 1. The morning this is for

It is 08:55. Sixteen patients are booked today. Almaz walks in for her 09:00
follow-up — the one Dr Sara booked at her last visit, which is free until the 28th.

**Today** the receptionist meets an empty form. She types "Almaz", picks her from a
dropdown, ticks the registration fee that is pre-ticked for her, chooses a department
she has to remember, chooses a dentist she has to remember, and takes 100 ETB.

Three things just went wrong, and nobody will notice any of them:

- Almaz was **charged 100 ETB for a visit that is free.** Her appointment says so;
  the desk never asked.
- Her appointment is still marked `booked`. Tonight it counts as a **no-show**, and
  this morning the dashboard says a patient has not arrived — while she is in the chair.
- The visit in the queue is **not linked to the appointment** Dr Sara made, so the
  follow-up she ordered has no recorded outcome.

**After** this redesign, the receptionist sees Almaz's name already on the screen, at
09:00, with `Follow-up · free until 28 Aug` beside it. She taps it, reads
"No fee — covered follow-up", presses **Check in**, and Almaz is in Dr Sara's queue.
Two taps, no money taken, appointment closed, follow-up linked.

---

## 2. What is actually wrong today (verified, not assumed)

### 2.1 A booked patient is processed as a walk-in

`ReceptionPage.tsx` has exactly two paths, and neither knows about appointments:
`raiseChargeBatch` + `settleVisit` when services are picked, and `walkIn` when they
are not (`ReceptionPage.tsx:132`, `:139`). The page never mentions an appointment —
`grep` for `assess|free_until|is_followup|check-in` returns nothing.

Meanwhile `POST /appointments/:id/check-in` already exists
(`scheduling/http/routes.go:21`) and already does the right thing: honours the triage
policy, marks the appointment `checked_in`, raises the intake charge **with the
appointment id**, and links the queue entry to it (`scheduling/service/service.go:317`).

Reception simply does not use it.

### 2.2 The free-follow-up rule cannot fire through the front door

The rule lives in one place and needs one thing:

```go
// billing/service/service.go:443
// A doctor-booked follow-up attended within its window is free…
if in.AppointmentID != nil { … return 0, nil }
```

`EnqueueWalkIn` calls that function **without an appointment id**
(`scheduling/service/service.go:396`), because a walk-in has none. So the clinic's own
rule — *free only for a doctor-booked follow-up within its window* — is unenforceable
by the person who takes the money. It works only if the patient is checked in from the
Appointments screen instead.

### 2.3 Unticking the fee does not make a visit free

Untick every service and press send: the page calls `walkIn`, which calls
`RaiseIntakeChargesTx`, which raises **every default service** again — with no dedupe
(`billing/service/service.go:454-464`). The patient the receptionist meant to let
through free is gated at the cashier instead. "Free" must be an explicit decision
(Waive, with a reason), never the absence of a tick.

### 2.4 The page cannot answer the desk's real questions

Standing at that desk you need to know: *who is expected today, who is already
waiting, is this person late, do they owe us anything, and is this visit free?* The
current page answers none of them. It also asks the receptionist to remember the
department and provider that were **already chosen when the appointment was booked**.

---

## 3. The redesign

### 3.1 The inversion

Today the page is a form you fill from nothing. It becomes **a list of the people who
are coming**, with search as the fallback for everyone else. Most arrivals are
expected; the expected case should be two taps, and the unexpected case should be no
harder than it is now.

### 3.2 Desktop (≥ lg)

```
┌─ Reception ───────────────────────────────── Sunday, 23 August ─────────────┐
│                                                                              │
│ ┌── TODAY ─────────────────────────────┐  ┌── CHECK IN ────────────────────┐ │
│ │ [Expected 12] [Waiting 3] [Seen 8]   │  │  Almaz Tesfaye    P000607      │ │
│ │ ┌──────────────────────────────────┐ │  │  24y · Female · 0911 44 55 66  │ │
│ │ │ 🔍 Search any patient…    [+ New]│ │  │                                │ │
│ │ └──────────────────────────────────┘ │  │  Booked 09:00 with Dr Sara     │ │
│ │                                      │  │  Root canal — follow-up        │ │
│ │  09:00  Almaz Tesfaye      P000607   │  │                                │ │
│ │  ▸ 24y F · Dr Sara                   │  │  ┌──────────────────────────┐  │ │
│ │    🟢 Free follow-up until 28 Aug    │  │  │ ✓ No fee                 │  │ │
│ │  ─────────────────────────────────── │  │  │ Follow-up covered until  │  │ │
│ │  09:20  Bereket Tadesse    P000412   │  │  │ 28 Aug — nothing to take │  │ │
│ │  ▸ 41y M · Dr Sara · 8 min late      │  │  └──────────────────────────┘  │ │
│ │    🔴 Owes 1,200                     │  │                                │ │
│ │  ─────────────────────────────────── │  │  Send to  [Dr Sara ▾]          │ │
│ │  09:40  Hanna Girma        P000188   │  │           (from the booking)   │ │
│ │  ▸ 33y F · Dr Yonas                  │  │                                │ │
│ │                                      │  │  [ ✓ Check in — no payment ]   │ │
│ └──────────────────────────────────────┘  └────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Left is the day. Right is the one person you are dealing with.** The left pane never
empties; the right pane is the only thing that changes.

### 3.3 The three lenses

| Lens | Who is in it | Why it exists |
|---|---|---|
| **Expected** (default) | Booked today, not yet arrived | The queue of the day, oldest slot first. Late slots surface at the top with a minutes-late badge |
| **Waiting** | Checked in and in the queue | So the desk can see what it created, and answer "how long have I been here?" |
| **Seen** | Done today | The proof of the day, and where to find someone who came back |

Counts live on the tabs, so the shape of the day is visible without switching.

### 3.4 A row, and why each part is on it

```
09:20  Bereket Tadesse   P000412        🔴 Owes 1,200
▸ 41y M · Dr Sara · 8 min late
```

- **Time first**, tabular, because the desk reads down a clock.
- **Late** in amber once the slot has passed — the same signal the dashboard counts.
- **Owes** in red: the patient is *standing there*. This is the single best moment in
  the whole product to recover old debt, and today the desk cannot see it.
- **Free follow-up** in green with its expiry, so nobody charges for a covered visit
  and nobody honours an expired one.
- **Provider**, because it is what the patient will ask about.

### 3.5 The check-in panel

Driven by `GET /billing/assess?patient=&appointment=` — which already exists
(`billing/http/routes.go:13`) and already knows the coverage rule.

**Covered follow-up** — no money UI at all. One green block, one button. Anything else
is an invitation to charge for a free visit.

**Ordinary visit**
```
Fee            Registration / visit fee            ETB 100.00
               [+ add a service]
               ────────────────────────────────────────────
               Total                               ETB 100.00

Payment        [ Telebirr  0911445566 ▾ ]
               Transaction reference  [ CH7K2M9QRS        ]
               [ Check with the bank ]          ← when verification is on

Send to        [ General Practice ▾ ]  [ Dr Sara ▾ ]     ← from the booking

[ Collect ETB 100.00 & check in ]   [ Send to cashier ]   [ Waive… ]
```

Three exits, named for what they do:
- **Collect & check in** — money now, straight to the queue.
- **Send to cashier** — the patient pays at the desk down the hall; they appear on the
  cashier's Pending list and enqueue themselves when it settles (existing behaviour).
- **Waive…** — free, with a reason, recorded. The *only* way a visit becomes free
  without payment, replacing the untick-everything path that never worked (§2.3).

**Owes money** — an amber strip above the buttons:
```
⚠ Owes 1,200 ETB from earlier visits (oldest 42 days)      [ See what is owed → ]
```
Surfaced, not silently bundled: adding old debt to today's payment changes what the
receipt says, and that is your call (§7, question 1).

### 3.6 Walk-in and new patient

The search box is always there. Typing a name searches every patient; picking one opens
the same panel with the appointment line absent and routing empty. **+ New** opens the
existing registration dialog and lands on that panel with the new patient selected —
register and receive in one motion, which is what actually happens at a desk.

### 3.7 Phone (< md)

One column: the list *is* the page. Tapping a row opens the check-in panel as a bottom
sheet (`fullOnMobile`, sticky footer) per the mobile conventions. Search and the lens
tabs stay pinned at the top; the tab bar keeps its place.

### 3.8 Behaviour

- **Live**: the list refetches every 30s, so a booking made on another screen appears.
- **Optimistic move**: on check-in the row leaves *Expected* and appears in *Waiting*
  immediately.
- **Guard kept**: the existing "already at the cashier" block stays — it is the thing
  that stops one patient being registered twice.
- **Empty states that say what to do**: "Nobody booked today — search for a walk-in."

---

## 4. What changes in the code

**Backend**

1. `GET /reception/today` — one request for the three lenses. Reuses the appointment
   list (which already carries `patient_name`, `mrn`, `provider_name`, `is_followup`,
   `free_until`, `status` — `scheduling/ports.go:43`), adds each patient's **owed**
   figure, and buckets the day in **Addis** (see `project-clinic-day-boundary`). One
   endpoint, like the dashboard, so the page paints at once.
2. Nothing else new. Check-in, assess, settle, waive and walk-in all exist.

**Frontend**

3. `ReceptionPage.tsx` rebuilt around the two panes. The payment block reuses
   `PaymentRailPicker` unchanged, so reception, the cashier and the pharmacy counter
   keep asking for payment the same way.
4. **A booked patient goes through `POST /appointments/:id/check-in`**, then settles
   with `POST /billing/checkout` when money is taken. That single change fixes §2.1,
   §2.2 and the no-show miscount, and it deletes Reception's private copy of the
   routing rules.
5. Walk-ins keep the current path.

**Deliberately not touched**: the queue and worklist screens, the cashier, the card-fee
policy itself, triage rules, and the appointment booking flow.

---

## 5. What this fixes, restated as outcomes

| Today | After |
|---|---|
| A covered follow-up is charged 100 ETB | It is free, and the desk is told why |
| Arrivals stay `booked`; the dashboard reports them as no-shows | Arrival closes the appointment |
| The visit is not linked to the follow-up the doctor ordered | It is |
| The desk cannot see that a patient owes 1,200 ETB | It is on the row, before they leave |
| Department and provider retyped from memory | Filled from the booking, editable |
| Unticking the fee silently re-raises it | Free is an explicit, recorded waiver |
| Every arrival starts with a search | Expected arrivals are already on screen |

---

## 6. Build order

1. `GET /reception/today` + the two-pane shell with the three lenses and search.
2. The check-in panel for **booked** patients (assess → check-in → settle).
3. The walk-in and new-patient paths onto the same panel.
4. Owes strip, late badges, optimistic moves, empty states.
5. Phone pass at 390px.

Each step is shippable; after step 2 the free-follow-up bug is already gone.

---

## 7. Questions I need answered before building

1. **Old debt at reception.** Surface it with a link to the cashier (my default), or
   let the desk add it to today's payment in one receipt?
2. **Extra services on a covered follow-up.** If a covered patient also needs an X-ray,
   the panel should let the desk add it and take payment for that alone. Confirm.
3. **Who may check in?** `check-in` requires `queue.manage`, the current reception flow
   requires `patient.create` + `payment.collect`. Should a receptionist without
   `payment.collect` be able to check in a covered follow-up (no money involved)? I
   would say yes.
4. **Seen lens** — worth building, or is Waiting + Expected enough for v1?
5. **Multi-branch**: the list is scoped to the active branch. Confirm that is right for
   a clinic whose reception covers two branches from one desk.
