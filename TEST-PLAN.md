# ClinicOS — End-to-end Test Drive (real-world walkthrough)

Play the platform as each real staff member, following one clinical story from
front door to follow-up. The goal is **not** to verify it works (it does) — it's
for **you** to feel whether each role's experience matches how you want the clinic
to run, and to capture every misalignment. Nothing is too small (wording, button
order, what a role sees, the steps themselves).

> There's an interactive companion to this file: **`clinicos-test-drive.html`**
> (open in any browser) — same content with progress tracking, per-act notes, and a
> one-click Markdown export of your feedback.

> A clean demo tenant has been prepared: no patients, no visits — a blank clinic
> ready to open for the day. Catalogs (drugs, lab tests, diagnoses, **billable
> services**) and stock are seeded.

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
right things, and nothing it shouldn't? Every page also has a **"How this works"**
button in the top bar, and a **Help center** at the bottom of the sidebar. 📝

---

## The story

> **Ato Abebe Bekele**, 54, walks in with chest pain since morning. He's a new
> patient. He'll be registered, **pay at the cashier**, be triaged, seen by the
> doctor, sent for an urgent **Troponin** (which comes back **critical**), then
> prescribed and sent home with a follow-up. Along the way a second patient
> (**Marta**, sore throat) and a counter customer exercise the lighter paths.

---

## Act 1 — Configure billing & flow (log in as **Clinic admin** or **Owner**)

**Goal:** price the clinic's services and choose how payments are collected.

1. **Settings → Patient flow.** Set the **card / consultation fee** and the
   **follow-up free window**. Set **Payment collection → Separate cashier** — this
   turns on the cashier flow used below. *(The other mode, "Reception collects",
   keeps the old inline behaviour.)*
2. **Billing → Service catalog.** Review the seeded services + prices (Consultation,
   wound dressing, injection, suturing…). **Edit a price**, and **toggle one Off then
   On** to see the availability switch.
3. (Glance at **Staff** — the 9 role accounts that come seeded.)

✅ Expect: cashier mode is on; services are priced. From now on, charges raised at
reception go to the cashier to collect.

- 📝 Service catalog — right services & ETB prices for your clinic? anything missing?
- 📝 Payment collection — is "separate cashier" vs "reception collects" the right choice to offer?

---

## Act 2 — Front desk (log in as **Receptionist**, Hanna)

**Goal:** register the new walk-in and send him to pay.

1. **Patients → Register** `Abebe Bekele`, male, ~54, with a phone number. **Add
   allergy `Penicillin`** (used later). On **Review**, confirm it registers **only
   when you click Register patient** (not when you press Enter).
2. **Test the duplicate guard:** start registering Abebe again with the same phone →
   you should get a **side-by-side "New vs Existing"** comparison (matching fields
   highlighted). Choose **Back to edit**.
3. Go to **Reception**. Pick Abebe, choose the **department** and **Triage first /
   Straight to doctor** (assign **Dr. Meron** if straight to doctor), then **Send to
   cashier**.

✅ Expect: Abebe has an MRN and a **pending consultation charge** at the cashier; he
is *not* in the queue yet — he advances once the cashier takes payment.

- 📝 Registration fields — right for an Ethiopian clinic? the duplicate comparison clear?
- 📝 The reception → cashier hand-off — wording and flow.

---

## Act 3 — Cashier (log in as **Cashier**, Bethel)

**Goal:** collect the payment so the patient can proceed.

1. Open **Cashier**. Abebe's **Consultation** charge is pending (grouped under his name with a total).
2. Pick a **payment method** (cash / card / mobile / transfer) and **Take payment**.
3. *(Try **Waive** on a charge — it requires a **reason**, e.g. Staff / Charity / Exemption.)*

✅ Expect: payment recorded; Abebe **auto-advances** into the queue (triage or the
doctor) per reception's routing; the cashier list clears.

- 📝 The pending-payments worklist — clear? grouped right? methods enough?
- 📝 Does "pay, then the patient proceeds automatically" match how your clinic runs?
- 📝 Waivers — is the reason list right? who should be allowed to waive?

---

## Act 4 — Triage (log in as **Nurse**, Kebede)

**Goal:** record vitals before the doctor sees him.

1. Open **Triage**, pick Abebe, and record vitals — make them concerning:
   **BP 165/100, HR 104, Temp 36.9, SpO₂ 96, weight 82**.
2. Confirm he stays in the queue for the doctor.

✅ Expect: vitals saved; the doctor will see them on the encounter.

- 📝 Vitals set — right measurements/units? anything you'd add (pain score, etc.)?
- 📝 Does the nurse see what they need and nothing they shouldn't?

---

## Act 5 — Consultation (log in as **Doctor**, Dr. Meron)

**Goal:** see the patient, order the urgent lab, park the visit while it runs.

1. Open **My day** → tabs **Waiting / In progress / Appointments / Done**. Abebe is under **Waiting**.
2. **Open consult**. Review the banner (Penicillin allergy visible) and the triage vitals.
3. Write a short **SOAP** note. Add a **diagnosis** (e.g. *"Essential hypertension"* or a cardiac entry).
4. **Try to prescribe `Amoxicillin`** → expect it **blocked** (Penicillin allergy, class-aware). Then prescribe **`Azithromycin 500mg`**, once daily, 3 days.
5. In **Orders / Lab**, order **Troponin** (priority **STAT**) and **CBC**.
6. Click **Set aside (awaiting results)** (don't sign yet).
7. **My day → In progress**: Abebe shows with the reason **"Awaiting lab (2)"**.

✅ Expect: allergy block fires; labs ordered; patient parked as *awaiting results* with the reason on the board.

- 📝 The board (4 tabs) — useful? what's missing?
- 📝 The consult workspace, SOAP, diagnosis search, prescribing.
- 📝 The "Set aside" idea and how the reason reads.

---

## Act 6 — Laboratory (log in as **Lab technician**, Yonas)

**Goal:** run the troponin.

1. **Lab worklist → To collect**. Find Abebe's **Troponin** (STAT, pinned to the top).
2. Try the **Scan / sample #** box: type the troponin's sample number → it opens.
3. **Receive & accession** the sample.
4. Enter a **critical** value — **Troponin = 5.0** — watch the flag turn red, then **Submit for validation**.
5. (Optional) Do the same for **CBC** with normal values.

✅ Expect: result auto-flags **Critical**; status → *resulted* (awaiting validation). The tech cannot validate.

- 📝 Worklist tabs and the scan box — match a real lab bench?
- 📝 Result entry — fast enough? reference ranges clear? flags obvious?

---

## Act 7 — Release the result & manage the catalog (log in as **Lab manager**, Tigist)

**Goal:** validate and release the result; manage the test catalog.

1. **Lab worklist → Awaiting validation**. Open Abebe's troponin (red **Critical** banner). **Validate & release**.
2. **Print report** — check the layout (patient header, value, flag, critical note).
3. **Test catalog:** **edit** a test (name/specimen), **toggle a test Available/Unavailable** (an *Unavailable* test disappears from the doctor's order list), and **edit an analyte's reference range**.
4. (Optional) **Import CSV** — paste a couple of rows to bulk-add.

✅ Expect: result released to the ordering doctor; full catalog management (edit /
availability / ranges), and an unavailable test can no longer be ordered.

- 📝 Two-person flow (tech → manager) — right?
- 📝 Catalog management — edit / availability / ranges: anything missing? printed report usable?

---

## Act 8 — Critical callback (log in as **Doctor**, Dr. Meron)

**Goal:** the doctor is alerted, acknowledges, and acts.

1. Sidebar: **Results inbox** shows a **red badge**.
2. **Results inbox → Criticals**. Abebe's troponin is pinned. Open it, review, then **Mark notified**.
3. **My day → In progress → Resume** Abebe's encounter. The **Orders / Lab** section shows the validated result (critical callout); confirm the Azithromycin prescription is there.
4. **Book a follow-up** for next week.
5. **Sign & close** the encounter.
6. **My day → Done** — Abebe is there; the badge/inbox critical is cleared.

✅ Expect: the critical reaches the doctor, is acknowledged, and the visit closes cleanly into Done.

- 📝 The inbox + badge — reliably gets a critical in front of the doctor?
- 📝 "Mark notified" — captures who/when? enough for safety?
- 📝 Follow-up booking and the close-out.

---

## Act 9 — Pharmacy (log in as **Pharmacist**, Dawit)

**Goal:** dispense the prescription; serve a counter customer.

1. **Dispense queue** — Abebe's signed prescription should be ready. Open it.
2. Note the **allergy banner**. Dispense **Azithromycin** — pick the FEFO batch, set quantity, counselling notes, **Counsel & dispense**. *(Amoxicillin/Tramadol batches are expired and skipped.)*
3. **OTC sale**: sell **Cetirizine 10mg** to a walk-in — search, add to cart, take payment.

✅ Expect: dispensing decrements stock and raises a charge; the OTC sale records a paid sale.

- 📝 Dispense flow — batch picking, allergy/expiry safety, counselling.
- 📝 OTC sale — does the counter flow match your pharmacy?

---

## Act 10 — Pharmacy back-office (log in as **Pharmacy manager**, Sara)

**Goal:** the management surface.

1. **Pharmacy dashboard** — KPIs, dispensing chart, alerts (low stock / expiry).
2. **Purchasing** — add a **supplier**, create a **PO** (restock Amoxicillin), mark it ordered, then **receive** → stock increases.
3. **Stock control** — start a **count**, enter a differing number, **adjust**, **approve**.
4. **Reports** — open a couple, then **Export CSV**.
5. **Catalog admin** — edit a drug (price/reorder level).

- 📝 Does the back-office cover what a pharmacy manager does day to day?
- 📝 Anything about suppliers, POs, counts, or reports off for your market?

---

## Act 11 — Finance (log in as **Owner** or a manager)

**Goal:** see the day's money.

1. Open **Billing → Finance**. Check **Collected / Waived / Outstanding** and the **by-service** breakdown.
2. Switch the range: **Today / Last 7 days / Last 30 days**.
3. Confirm Abebe's **Consultation** shows under *collected*; any **waived** charge shows under *waived* (revenue forgone).

✅ Expect: money taken, waived, and still owed is visible at a glance, by service.

- 📝 Does this give an owner what they need day to day? what's missing (per-cashier totals, CSV export, custom dates)?

---

## Act 12 — A second, lighter visit (Reception → Cashier → Doctor → Lab, your choice of role)

Run **Marta Tadesse**, 28, sore throat: register → **send to cashier** → pay →
triage → doctor orders a **Rapid strep test** → lab enters *"Positive"* (non-numeric)
→ doctor prescribes. Checks a non-numeric, non-critical result and the cashier path
on a faster visit.

- 📝 Anything that felt different/awkward on a simpler visit?

---

## Act 13 — Admin, settings & help (log in as **Owner** or **Clinic admin**)

1. **Staff** — review the staff and their roles; try inviting a user.
2. **Settings** — the **card fee**, **free-follow-up window**, **payment collection mode**, and the **diagnosis catalog**.
3. **Help** — open the **Help center** (bottom of the sidebar) for the role you're in, and click **"How this works"** in the top bar on any page.
4. Confirm the **follow-up is free**: a doctor-booked follow-up within the window isn't charged. *(Shorten the window in Settings to test quickly.)*

- 📝 Settings — everything a clinic needs to configure here? labels clear?
- 📝 Help center / "How this works" — does it make each role self-explanatory?
- 📝 Roles/permissions — does each role see the right things and nothing it shouldn't?

---

## Feature coverage checklist (tick as you go)

**Front office:** ☐ register patient ☐ patient search ☐ duplicate comparison (new vs existing)
☐ explicit-submit (no auto-register) ☐ allergies/conditions ☐ walk-in ☐ appointment booking ☐ check-in ☐ queue/assign

**Clinical:** ☐ triage vitals ☐ My-day board (4 tabs) ☐ SOAP note ☐ diagnosis catalog
☐ prescribing ☐ allergy guard ☐ set-aside/awaiting-results ☐ sign & close ☐ history timeline

**Billing:** ☐ service catalog (price + CRUD) ☐ payment-mode toggle ☐ reception → cashier hand-off
☐ cashier worklist ☐ take payment (methods) ☐ waive with reason ☐ auto-advance after payment
☐ finance: collected/waived/outstanding ☐ free follow-up

**Lab:** ☐ order labs (active-only) ☐ worklist ☐ scan/sample lookup ☐ accession ☐ result entry + auto-flag
☐ submit ☐ validate/release ☐ critical escalation ☐ results inbox + badge ☐ mark notified
☐ print report ☐ catalog edit + availability ☐ CSV import

**Pharmacy:** ☐ dispense (FEFO + allergy + expiry) ☐ OTC sale ☐ dashboard ☐ purchasing/PO receive
☐ stock count ☐ reports + CSV ☐ catalog admin ☐ batches/expiry

**Admin & help:** ☐ staff/roles ☐ settings (fee, window, payment mode) ☐ diagnosis catalog
☐ Help center + "How this works" ☐ teaching empty states ☐ per-role nav correctness

---

## Quick feedback capture (dump anything, I'll triage into REFINEMENT.md)

| # | Area / role | What feels off | What you'd want instead |
|---|---|---|---|
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |

> When you've gone through it, hand me your notes (in any form) — or use the HTML
> companion's **Export notes** button. I'll turn them into a triaged refinement
> backlog (`REFINEMENT.md`) and a batched plan for your approval.
