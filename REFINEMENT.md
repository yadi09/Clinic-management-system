# ClinicOS — Refinement Backlog

Feedback from end-to-end role testing, captured before refining. Each item:
**area · role · type · what's misaligned → proposed fix · status**.

Types: `workflow` · `crud` · `wording/locale` · `ux` · `guard` · `data` · `perf`.
Status: `logged` → `planned` → `in-progress` → `done`.

---

## Laboratory

- **[LAB-1] Lab catalog · Lab Manager · crud** — Can only *add* tests/analytes (and
  Import CSV); cannot edit, deactivate, or delete existing tests or analytes.
  A wrong reference/critical range can't be corrected → silently mis-flags every
  future result (safety gap). **Proposed:** full CRUD on tests (edit name/specimen,
  toggle `is_active`, delete-when-unreferenced else deactivate) and analytes (edit
  unit/ranges, delete-when-unreferenced); add `is_active`/soft-delete to
  `lab_analytes`. Match the diagnosis-catalog CRUD pattern. *Status: **done** (Batch A,
  commit pending) — tests: edit + availability toggle + soft-delete; analytes: edit +
  delete-when-unreferenced (409 ANALYTE_HAS_RESULTS otherwise). No analyte soft-delete
  column needed in the end.*

- **[LAB-2] Lab catalog · Lab Manager · workflow** — Lab manager needs an
  **availability on/off toggle** per test (clinic offers some tests, not others).
  *Good news:* `lab_tests.is_active` already exists and the doctor order dialog
  already lists active-only — so this is mainly the missing toggle UI (folds into
  [LAB-1]). **Decided:** doctor sees **available (active) tests only** — unavailable
  tests are hidden entirely (no "show unavailable" affordance; catalogs can be
  hundreds of tests and that would overwhelm the doctor). Lab manager flips
  availability per test via an `is_active` toggle on the catalog page.
  *Status: **done** (Batch A) — Available/Unavailable pill on each test; doctor order
  dialog already lists active-only.*

- **[LAB-3 · open question] Lab catalog · Lab Manager/Doctor · workflow** — User
  referenced ordering "from the category"; the **lab catalog has no categories**
  today (tests→analytes only; categories are on the *diagnosis* catalog). Decide
  whether to add **test categories/grouping** (e.g. Hematology / Chemistry /
  Microbiology) to the catalog + order dialog. *Status: needs-decision*

---
## Patients / Registration

- **[REG-1] Register patient · Reception · guard (bug)** — The multi-step form was a
  single `<form onSubmit>`, so pressing **Enter** in a field registered the patient
  immediately, bypassing the Review step. **Fixed:** form no longer submits
  implicitly; registration fires only from the explicit "Register patient" button on
  Review. *Status: **done** (commit pending).*

- **[REG-2] Register patient · Reception · ux** — The duplicate dialog only listed
  the existing match. **Fixed:** side-by-side comparison — "New — registering now"
  (the entered details) vs each "Existing patient" (name/MRN/DOB/phone), with matching
  fields highlighted and an "Open record" link; actions are "Back to edit" /
  "Different person — register new". *Status: **done** (commit pending).*

---

## Billing / Payments

- **[CASH-1] Cashier role + payments flow · Cashier/Reception · workflow (large)** —
  Today the Cashier login lands on the **Reception page** (register + route) and the
  card fee is collected **inline at the desk**. Desired model = **centralized
  pending-payments with a cashier settlement station**:
  - Reception (and later lab, pharmacy, other services) **raise a pending charge**
    instead of collecting money themselves.
  - Cashier has a **pending-payments worklist** (patient · amount · what it's for) →
    **settle/approve**.
  - Service is **gated on payment**: a patient routed "to triage/doctor" stays
    *pending* until paid; **on settlement the routing auto-advances** to the chosen
    next step (no rework at reception).
  - Charge types flowing through it: registration/card fee, **lab tests**,
    **pharmacy**, **other clinic services** — one unified queue.
  - **Configurable in admin:** `payment_mode` — *separate cashier* (route → cashier →
    pay → proceed) vs *reception collects* (current inline). Some clinics split the
    role, some don't.
  - **Own UI** for the cashier (payments worklist), distinct from Reception; + UX polish.
  - **Open decisions (build time):** hard-block vs reception **override**
    (emergency/insurance/credit/"pay later"); which charge types in v1; per-tenant vs
    per-branch setting; free-follow-up raises no charge (keep consistent).
  - **Scope:** this is effectively the **Billing/checkout phase**; the cashier is its
    front line. Likely its own phase, not a quick refinement.
  *Status: **Billing-1 done** (backend 5909eab + frontend) — service catalog (admin
  config of what's billable + price), charges spine, **Cashier** worklist
  (settle by method / waive), configurable `payment_mode` (Settings → Payment
  collection), reception cashier-mode raises a consultation charge that
  auto-advances the patient on settlement, and a **Finance** view
  (collected/waived/outstanding + by-source). **Billing-2 deferred:** lab/pharmacy
  charges, printable receipts, free-follow-up handling in cashier mode.*

- **[CASH-2] Payment waiver / exemption · Reception · workflow** — Reception must be
  able to register/route a patient **without payment** for legitimate cases (staff,
  charity, exemption), but with **a documented reason** — not a silent skip. Smart
  model: at the charge point, three dispositions — *collect/route-to-cashier*
  ([CASH-1]), **waive (free, with reason)**, *(maybe)* credit/insurance (bill later,
  distinct from waive). Waiver requires:
  - **Required reason** from an **admin-configurable list** (Staff/dependent,
    Indigent/charity, Exemption program, Courtesy/VIP, Insurance/credit, Other+note).
  - **Attributed + timestamped + audited** (who/when/why + amount forgone) — non-repudiable.
  - **Optional gate** — `payment.waive` permission and/or manager approval above an
    amount (configurable per clinic).
  - **Waiver report** — who waived what, why, total revenue forgone (manager visibility).
  - **Unify with the existing free-follow-up rule** — treat it as a *system-applied*
    waiver (reason "follow-up within window") so manual + automatic waivers are one
    concept shown consistently. *Status: **core done** (Billing-1) — waive at the
    cashier with a required reason, attributed (settled_by/at) + audited via event;
    Finance shows waived total/count. **Deferred:** admin-editable reason list
    (fixed list for now), a per-waiver who/why report, and the free-follow-up
    auto-waiver unification.*

---

- **[CASH-3] Billing config · Admin/Reception · workflow** — Prices must live in
  **one place — the service catalog**, not split with a Settings "fee amount".
  **Remove** the card-fee *amount* (and on/off) from Settings (keep only flow rules:
  payment mode, triage, doctor assignment, free-follow-up window). **Tag services as
  `is_default`** (e.g. a seeded **Registration fee**); admin toggles the tag.
  **Reception picks the service(s)** the patient is here for — defaults pre-checked,
  can add/remove (registration, consultation, procedure…) → raises a charge per
  selected service (itemized); visit still gates + auto-advances on settle, guarded
  so multiple line-items enqueue the patient only once. Same in both payment modes
  (always priced from the catalog). *Status: **done** (migration 0015) — service_items
  gain `is_default`; Settings no longer holds a fee amount (note points to the
  catalog); Service-catalog page has a **Default** toggle; **Reception is now a
  service picker** (defaults pre-checked) that raises a charge per chosen service;
  the patient **auto-advances only once nothing is owed** (CountPendingChargesByPatient
  + CountActiveQueueByPatient guards), in both payment modes. Seeded a **Registration
  fee** (default) + Consultation (default). Smoke PASS.*

---

## Cross-cutting / Platform

- **[HELP-1] All pages · all roles · ux** — Per-role **Help Center + self-teaching
  UI** so non-expert clinic staff understand every page/column/action without
  training. Two tracks: **(A) make the UI self-evident** — per-page "How this page
  works" panel (KPIs, table columns, actions explained), term tooltips (FEFO,
  flags, STAT, accession, card fee, MRN), and **teaching empty states** (e.g.
  "Nothing to dispense." → "No signed prescriptions yet. When a doctor signs one it
  lands here ready to dispense."). **(B) Help Center** — a "Help" nav item (bottom)
  → role-scoped guide (each page + "how your day flows" workflow map + FAQs) and a
  **first-run guided tour** (coachmarks, replayable). **Media:** text+tooltips+tour
  as backbone; a few short GIFs for the 3–4 trickiest flows; **defer full video**
  (low-bandwidth Ethiopia + single VPS). **Build approach:** help content as
  structured **data keyed by route+role** (one `<PageHelp>` component + a `/help`
  page render from the same source) → consistent, low-maintenance, **Amharic-ready**.
  Phasing: P1 panels/tooltips/empty-states/Help page · P2 first-run tour · P3 GIFs +
  Amharic. **Evidence/priority:** owner *deferred testing the Pharmacist +
  Pharmacy-Manager roles entirely* because the pages weren't self-explanatory — so
  P1 is effectively a launch-blocker for staff onboarding, not a nice-to-have.
  *Status: **P1 done** (Batch B) — data-driven `help/content.ts`; per-page "How this
  works" header dialog (purpose + sections + column meanings + tips); role-scoped
  Help Center at /help + Help nav item; teaching empty states (dispense queue + lab
  worklist); content authored for all nav-reachable pages. **P2** first-run tour and
  **P3** GIFs + Amharic still deferred.*

- **[PHARM-todo] Pharmacy · Pharmacist + Pharmacy Manager · (pending)** — Roles not
  yet evaluated; owner will test them after HELP-1 P1 makes the pages
  self-explanatory. Revisit pharmacy feedback then. *Status: deferred*

---

<!-- New items append under the matching area heading. -->
