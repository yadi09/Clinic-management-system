# Patient Workflow (canonical)

**Status:** approved **v4** (2026-06-12). This is the end-to-end clinical flow ClinicOS
builds to. Everything here is **configurable per clinic** ("configurable, not custom") —
revisit and version this doc as we learn more.

Market: Ethiopia / East Africa — ETB currency, ICD-10, `Africa/Addis_Ababa`.

---

## Principles
- **Walk-in is the default**; appointments are optional (today or future-dated follow-ups).
- A clinic **toggles stages and rules**; we never fork code per clinic.
- Payment is modelled as **gates** ("pay before this service"), not one checkout.

---

## End-to-end flow

```
  🚶 ARRIVES:   walk-in (default)  │  scheduled follow-up  │  ⚙ direct-to-service*
        │
        ▼
 ╔═ RECEPTION ═══════════════════════════════════════════════════════════╗
 ║  find / register patient (MRN)                                         ║
 ║  💰 CARD = registration + CONSULTATION:                                ║
 ║     • walk-in (no appointment)               → PAY (every time)        ║
 ║     • doctor-booked follow-up, within window → FREE  (⚙ e.g. 30 days)  ║
 ║     • follow-up attended late / self walk-in → PAY                     ║
 ║     ⚙ amount · free-window days · waiver                               ║
 ║  route → department  (triage, or straight to doctor)                   ║
 ╚════════════════════════════════╤═══════════════════════════════════════╝
                                   ▼
 ⚙ TRIAGE (optional) · nurse → vitals → ASSIGN doctor
                                   │   (reception assigns if triage off)
                                   ▼
 ╔═ DOCTOR WORKLIST → CONSULTATION / EMR · doctor ════════════════════════╗
 ║  banner + ⚠allergies · vitals · SOAP (sign&lock) · diagnosis · Rx      ║
 ║  outcomes ↓                                                            ║
 ║   • order LAB   • prescribe → PHARMACY   • ⚙REFER   • book FOLLOW-UP    ║
 ╚════╤══════════════════╤═══════════════════════╤═══════════════════╤═════╝
      ▼                  ▼                        ▼                   ▼
 ⚙LAB (if enabled)   PHARMACY              ⚙ REFER / REASSIGN     FOLLOW-UP
  💰 pay BEFORE       pharmacist has Rx:    • reassign doctor      booked by
   service (if dept    • in stock →          (same clinic)         doctor →
   requires); per-      💰pay → dispense    • refer to specialist  FREE if
   test price from     • not in stock →      / dept (internal) →   attended
   ⚙price list →        print Rx → buy        re-enters routing     within
   collect→result→      outside             • refer OUT to another  window
   back to doctor                            hospital → referral
                                             letter (print/record)
      └──────────────────┴───────────────────────┘
                                   ▼
 ╔═ CHECKOUT · cashier (⚙ same person as reception, or separate) ═════════╗
 ║  any remaining service charges → invoice → pay → receipt              ║
 ╚════════════════════════════════╤═══════════════════════════════════════╝
                                   ▼
            DISCHARGE — visit saved to history · follow-up (if booked)

 * ⚙ direct-to-service = straight to lab / OTC pharmacy without a doctor (if clinic enables it)
```

---

## The payment rule (card = registration + consultation)
The card fee covers **registration + the doctor consultation**. The "free re-visit" is
gated on a **doctor-booked follow-up**, NOT merely on the calendar:

- **Walk-in** (no appointment) → **pays every time**, even within the window.
- A **doctor-booked follow-up** attended **within its free window** (⚙ default 30 days) → **free**.
- A follow-up attended **late**, or any **self-initiated walk-in** → **pays**.

> "Free" ⟺ you are here for a follow-up the doctor booked, within its window. Everything else pays.

**Configurable:** fee amount (ETB) · free-window days · whether a receptionist may **waive**.

---

## Payment as gates
Any department/service can be flagged **"payment required before service"**:
- **Card fee** = the *reception* gate (covers the consultation).
- **Lab** = a prepay gate; price **per test** from a configurable **price list**.
- **Pharmacy** = charges on dispense.

---

## Stations, roles & rules

| Station | Role | What happens |
|---|---|---|
| Reception | Receptionist (and/or Cashier) | Register/find patient, apply the card rule, collect/​waive, route into the flow |
| Triage *(⚙ optional)* | Nurse | Record vitals, **assign a doctor** (specific or "any available") |
| Doctor worklist | Doctor (own account) | See **only their assigned patients** ("waiting for me") |
| Consultation / EMR | Doctor | Vitals review, SOAP (sign & lock), diagnosis (ICD), prescription (allergy check), orders, **book follow-up**, **refer** |
| Lab *(⚙ optional)* | Lab tech | Prepay gate, collect, result → back to ordering doctor |
| Pharmacy | Pharmacist | In stock → pay → dispense (batch/expiry, FEFO); not in stock → print Rx for outside purchase; OTC sale (⚙) |
| Checkout | Cashier *(⚙ = reception or separate, by permission)* | Remaining service charges → invoice → receipt |

---

## Referral / reassignment
- **Reassign** the patient to **another doctor** in the same clinic (e.g. doctor out, load-balancing) — same visit.
- **Refer (internal)** to another **department / specialist** → patient re-enters routing, carrying a referral note; **no new card fee within the window**.
- **Refer out (external)** to **another hospital** → a **referral letter** is printed / recorded.
- One **visit** may contain **multiple encounters** (GP → specialist).

---

## Configurable per clinic (summary)
appointments optional (walk-in default) · card fee (amount, free-window days, waiver) ·
triage on/off · doctor assignment (manual now; auto later) · per-department prepay gate ·
lab module on/off + per-test price list · pharmacy dispense-or-print + OTC ·
direct-to-service on/off · referral (internal + external) · cashier = reception or separate (by permission).

---

## Build mapping (phases)
- ✅ **Phase 1** — reception register/search, clinic settings, RBAC.
- ✅ **Phase 2** — appointments (no double-booking) + walk-in queue (live SSE).
- ⬜ **Phase 3a** — card fee + payment rule, optional triage (vitals) + **doctor assignment**, **per-doctor worklist**, settings.
- ⬜ **Phase 3b** — consultation / EMR (SOAP, diagnosis, prescription, sign & lock, **book follow-up**, **referral**).
- ⬜ **Later** — Lab (prepay + price list), Pharmacy (dispense/print/OTC), Billing & checkout, external referral letters, dynamic form builder.
