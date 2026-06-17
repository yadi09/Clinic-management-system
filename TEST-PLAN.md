# ClinicOS — End-to-end Test Drive (real-world walkthrough)

Play the platform as each real staff member, following one clinical story from
front door to follow-up. The goal is **not** to verify it works (it does) — it's
for **you** to feel whether each role's experience matches how you want the clinic
to run, and to capture every misalignment. Nothing is too small (wording, button
order, what a role sees, the steps themselves).

> A clean demo tenant has been prepared: no patients, no visits — a blank clinic
> ready to open for the day. Catalogs (drugs, lab tests, diagnoses) and stock are
> seeded.

---

## How to run

- **URL:** http://localhost:8088  ·  **Workspace:** `demo`
- Open a separate browser **profile/incognito window per role** if you want to be
  several people at once (otherwise just log out and back in).
- Capture feedback inline — write under the `📝` lines, or keep a running list.

### Logins (workspace `demo`)

| Role | Email | Password |
|---|---|---|
| Owner (sees everything) | `owner@demo.clinic` | `ChangeMe123!` |
| Clinic admin | `admin@demo.clinic` | `Test1234!` |
| Receptionist — *Hanna* | `reception@demo.clinic` | `Test1234!` |
| Nurse / triage — *Kebede* | `nurse@demo.clinic` | `Test1234!` |
| Doctor — *Dr. Meron* | `doctor@demo.clinic` | `Test1234!` |
| Lab technician — *Yonas* | `labtech@demo.clinic` | `Test1234!` |
| Lab manager — *Tigist* | `labmgr@demo.clinic` | `Test1234!` |
| Pharmacist — *Dawit* | `pharmacist@demo.clinic` | `Test1234!` |
| Pharmacy manager — *Sara* | `pharmacymgr@demo.clinic` | `Test1234!` |
| Cashier — *Bethel* | `cashier@demo.clinic` | `Test1234!` |

As you sign in to each, first just **look at the sidebar**: does this role see the
right things, and nothing it shouldn't? 📝

---

## The story

> **Ato Abebe Bekele**, 54, walks in with chest pain since morning. He's a new
> patient. He'll be registered, triaged, seen by the doctor, sent for an urgent
> **Troponin** (which comes back **critical**), then prescribed and sent home with
> a follow-up. Along the way a second patient (**Marta**, sore throat) and a
> counter customer exercise the lighter paths.

---

## Act 1 — Front desk (log in as **Receptionist**, Hanna)

**Goal:** register the new walk-in, take the card fee, put him in the queue for the doctor.

1. **Patients → Register** a new patient: `Abebe Bekele`, male, DOB making him ~54,
   add a phone number. **Add an allergy: `Penicillin`** (we'll use this later).
2. Go to **Reception**. Find Abebe as a walk-in, **collect the card fee**, and send
   him into the flow (to triage / the queue).
3. Open **Queue** and **assign him to Dr. Meron Haile**.

✅ Expect: Abebe has an MRN; the card fee is recorded as paid; he now appears in the
queue assigned to Dr. Meron.

- 📝 Registration form — fields right? anything missing for an Ethiopian clinic?
- 📝 The card fee step — amount, wording, where it's set?
- 📝 Walk-in vs appointment, routing to the queue — does the flow match yours?

---

## Act 2 — Triage (log in as **Nurse**, Kebede)

**Goal:** record vitals before the doctor sees him.

1. Open **Triage**, pick Abebe, and record vitals — make them concerning:
   **BP 165/100, HR 104, Temp 36.9, SpO₂ 96, weight 82**.
2. Confirm he stays in the queue for the doctor.

✅ Expect: vitals saved; the doctor will see them on the encounter.

- 📝 Vitals set — right measurements/units? anything you'd add (pain score, etc.)?
- 📝 Does the nurse see what they need and nothing they shouldn't?

---

## Act 3 — Consultation (log in as **Doctor**, Dr. Meron)

**Goal:** see the patient, order the urgent lab, park the visit while it runs.

1. Open **My day**. Look at the four tabs: **Waiting / In progress / Appointments /
   Done**. Abebe should be under **Waiting**.
2. **Open consult** on Abebe. Review the banner (allergy to Penicillin should be
   visible) and the triage vitals.
3. Write a short **SOAP** note. Add a **diagnosis** (search the catalog, e.g.
   *"Essential hypertension"* or a cardiac entry).
4. **Try to prescribe `Amoxicillin`** → expect it to be **blocked** (Penicillin
   allergy, class-aware). Then prescribe **`Azithromycin 500mg`**, once daily, 3 days.
5. In **Orders / Lab**, order **Troponin** (priority **STAT**) and **CBC**.
6. Click **Set aside (awaiting results)** (don't sign yet).
7. Go back to **My day → In progress**: Abebe should be there with the reason
   **"Awaiting lab (2)"**.

✅ Expect: allergy block fires on Amoxicillin; labs ordered; the patient is parked as
*awaiting results* and shows on the board with the reason.

- 📝 The board (Waiting/In progress/Appointments/Done) — useful? what's missing?
- 📝 The consult workspace layout, SOAP, diagnosis search, prescribing.
- 📝 The "Set aside" idea and how the reason reads.

---

## Act 4 — Laboratory (log in as **Lab technician**, Yonas)

**Goal:** run the troponin.

1. Open **Lab worklist** → **To collect**. Find Abebe's **Troponin** (STAT, should be
   pinned to the top by priority).
2. Try the **Scan / sample #** box: type the troponin's sample number → it opens.
3. **Receive & accession** the sample.
4. Enter a **critical** value — **Troponin = 5.0** — watch the flag turn red, then
   **Submit for validation**.
5. (Optional) Do the same for **CBC** with normal values (e.g. all mid-range).

✅ Expect: the result auto-flags **Critical**; status moves to *resulted* (awaiting
validation). The tech cannot validate (that's the manager's job).

- 📝 Worklist tabs and the scan box — does this match how a lab bench works?
- 📝 Result entry — fast enough? reference ranges clear? flags obvious?

---

## Act 5 — Release the result (log in as **Lab manager**, Tigist)

**Goal:** validate and release; print the report.

1. **Lab worklist → Awaiting validation**. Open Abebe's troponin. Note the red
   **Critical value** banner.
2. **Validate & release**.
3. **Print report** — check the printed layout (patient header, value, flag,
   critical note).
4. (Optional) **Test catalog**: try **Import CSV** (paste a couple of rows) and add a
   test, to see catalog management.

✅ Expect: result released to the ordering doctor; a critical now needs acknowledgement.

- 📝 Validation step — who should be allowed? is the two-person flow (tech → manager) right?
- 📝 The printed report — is it something you'd hand a patient / file?

---

## Act 6 — Critical callback (back as **Doctor**, Dr. Meron)

**Goal:** the doctor is alerted, acknowledges, and acts.

1. Look at the sidebar: **Results inbox** should show a **red badge**.
2. Open **Results inbox → Criticals**. Abebe's troponin is pinned. Open it, review,
   then **Mark notified**.
3. Return to **My day → In progress → Resume** Abebe's encounter. The **Orders / Lab**
   section shows the validated result (with a critical callout). Confirm the
   Azithromycin prescription is there.
4. **Book a follow-up** for next week.
5. **Sign & close** the encounter.
6. Check **My day → Done** — Abebe is there; the badge/inbox critical is cleared.

✅ Expect: the critical reaches the doctor, is acknowledged, and the visit closes
cleanly into Done.

- 📝 The inbox + badge — does this reliably get a critical in front of the doctor?
- 📝 "Mark notified" — does it capture what you need (who/when)? enough for safety?
- 📝 Follow-up booking and the close-out.

---

## Act 7 — Pharmacy (log in as **Pharmacist**, Dawit)

**Goal:** dispense the prescription; serve a counter customer.

1. **Dispense queue** — Abebe's signed prescription should be ready. Open it.
2. Note the **allergy banner** (Penicillin). Dispense **Azithromycin** — pick the
   FEFO batch, set quantity, add counselling notes, **Counsel & dispense**.
   *(Notice Amoxicillin/Tramadol batches are expired and would be skipped.)*
3. **OTC sale**: sell **Cetirizine 10mg** to a walk-in customer — search, add to cart,
   take payment.

✅ Expect: dispensing decrements stock and raises a charge; the OTC sale records a paid sale.

- 📝 Dispense flow — batch picking, allergy/expiry safety, counselling.
- 📝 OTC sale — does the counter flow match your pharmacy?

---

## Act 8 — Pharmacy back-office (log in as **Pharmacy manager**, Sara)

**Goal:** the management surface.

1. **Pharmacy dashboard** — KPIs, the dispensing chart, alerts (low stock / expiry).
2. **Purchasing** — add a **supplier**, create a **purchase order** (e.g. restock
   Amoxicillin), mark it ordered, then **receive** it → stock should increase.
3. **Stock control** — start a **count**, enter a counted number that differs,
   **adjust**, **approve**.
4. **Reports** — open a couple, then **Export CSV**.
5. **Catalog admin** — edit a drug (price/reorder level).

- 📝 Does the back-office cover what a pharmacy manager actually does day to day?
- 📝 Anything about suppliers, POs, counts, or reports that's off for your market?

---

## Act 9 — A second, lighter visit (Reception → Doctor → Lab, your choice of role)

Run **Marta Tadesse**, 28, sore throat, quickly through: register → card fee →
triage → doctor orders a **Rapid strep test** → lab enters result *"Positive"*
(non-numeric) → doctor prescribes. This checks the flow with a non-numeric,
non-critical result and a faster visit.

- 📝 Anything that felt different/awkward on a simpler visit?

---

## Act 10 — Admin & settings (log in as **Owner** or **Clinic admin**)

1. **Staff** — review the 9 staff and their roles; try inviting a user.
2. **Settings** — patient-flow settings (the **card fee amount**, **free follow-up
   window**), and the **diagnosis catalog** (categories + entries).
3. Confirm the **follow-up is free**: a doctor-booked follow-up within the window
   should not be charged the card fee at reception. *(Check back in Reception when
   Abebe's follow-up date arrives, or shorten the window in Settings to test.)*

- 📝 Settings — is everything a clinic needs to configure here? labels clear?
- 📝 Roles/permissions — does each role's access match your intent?

---

## Feature coverage checklist (tick as you go)

**Front office:** ☐ register patient ☐ patient search/dedup ☐ allergies/conditions
☐ card fee ☐ walk-in ☐ appointment booking ☐ check-in ☐ queue/assign ☐ free follow-up

**Clinical:** ☐ triage vitals ☐ My-day board (4 tabs) ☐ SOAP note ☐ diagnosis catalog
☐ prescribing ☐ allergy guard ☐ set-aside/awaiting-results ☐ sign & close ☐ history timeline

**Lab:** ☐ order labs ☐ worklist ☐ scan/sample lookup ☐ accession ☐ result entry + auto-flag
☐ submit ☐ validate/release ☐ critical escalation ☐ results inbox + badge ☐ mark notified
☐ print report ☐ catalog + CSV import

**Pharmacy:** ☐ dispense (FEFO + allergy + expiry) ☐ OTC sale ☐ dashboard ☐ purchasing/PO receive
☐ stock count ☐ reports + CSV ☐ catalog admin ☐ batches/expiry

**Admin:** ☐ staff/roles ☐ settings (card fee, window) ☐ diagnosis catalog ☐ per-role nav correctness

---

## Quick feedback capture (dump anything, I'll triage into REFINEMENT.md)

| # | Area / role | What feels off | What you'd want instead |
|---|---|---|---|
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |

> When you've gone through it, hand me your notes (in any form). I'll turn them into
> a triaged refinement backlog (`REFINEMENT.md`) and a batched plan for your approval.
