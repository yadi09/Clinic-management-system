// Self-teaching help content, keyed by route. One source of truth for both the
// in-page "How this works" panel (<PageHelp>) and the Help Center (/help), so
// it stays consistent and is easy to keep in sync / translate (Amharic) later.

export interface HelpColumn {
  name: string;
  desc: string;
}
export interface HelpSection {
  h: string;
  body: string;
}
export interface HelpEntry {
  /** the page label shown in the Help Center */
  title: string;
  /** one-line "what this page is for" */
  purpose: string;
  /** step-by-step / how-it-works notes */
  sections?: HelpSection[];
  /** table column or KPI explanations */
  columns?: HelpColumn[];
  /** gotchas / good-to-know */
  tips?: string[];
}

// Shared glossary — terms that show up across roles.
export const GLOSSARY: { term: string; def: string }[] = [
  { term: "MRN", def: "Medical Record Number — the patient's unique ID in this clinic." },
  { term: "Card / consultation fee", def: "The fee a patient pays to be seen. Configurable in Settings; a doctor-booked follow-up within the window is free." },
  { term: "FEFO", def: "First-Expiry-First-Out — the system dispenses the batch that expires soonest, to reduce waste." },
  { term: "Batch", def: "A specific lot of a drug with its own expiry date and quantity on hand." },
  { term: "Accession", def: "Receiving a specimen into the lab and marking it collected, so results can be entered." },
  { term: "Critical value", def: "A result so abnormal it needs the doctor told urgently. It must be acknowledged ('Mark notified')." },
  { term: "STAT / Urgent / Routine", def: "Lab order priority. STAT is most urgent and sorts to the top of the worklist." },
  { term: "Awaiting results", def: "An encounter the doctor parked while labs run; it stays editable and shows on the My-day board." },
];

// Route → help. Dynamic segments use ':id' and are matched by helpForPath().
export const HELP: Record<string, HelpEntry> = {
  "/": {
    title: "Dashboard",
    purpose: "Your home screen — a snapshot for your role and quick links into the day's work.",
  },

  // ---- Pharmacy ----
  "/pharmacy/queue": {
    title: "Dispense queue",
    purpose: "Signed prescriptions waiting to be dispensed. Click a row to dispense it.",
    columns: [
      { name: "RX", desc: "Prescription number (R-####)." },
      { name: "Patient", desc: "Who it's for, with their MRN." },
      { name: "Prescriber", desc: "The doctor who signed it." },
      { name: "Items", desc: "How many medication lines are on the prescription." },
      { name: "Flags", desc: "Safety alerts — e.g. a patient allergy that affects a drug on this prescription." },
      { name: "Status", desc: "‘ready’ = waiting for you; ‘dispensed’ = already handed out." },
    ],
    sections: [
      { h: "The 4 cards at the top", body: "To dispense (waiting now) · Dispensed today · Low stock (drugs at/under reorder level) · Near expiry (batches expiring soon)." },
      { h: "To dispense", body: "Open a ‘ready’ row → pick the batch (FEFO is pre-selected) and quantity → add counselling notes → Counsel & dispense. Stock is decremented and a charge is raised automatically." },
    ],
    tips: ["Expired or quarantined batches are skipped automatically.", "If a drug is out of stock you can print the script for the patient to buy outside."],
  },
  "/pharmacy/otc": {
    title: "OTC sale",
    purpose: "Over-the-counter counter sales — no prescription needed (e.g. selling paracetamol to a walk-in).",
    sections: [
      { h: "Make a sale", body: "Search a drug → add to the cart → set quantities → apply any discount/tax → take payment. The system picks an in-date batch and records a paid sale." },
    ],
    tips: ["OTC sales aren't allergy-checked by design — they're counter purchases, not prescribed care."],
  },
  "/pharmacy/catalog": {
    title: "Drug catalog",
    purpose: "The list of drugs this pharmacy stocks, with price, class, and current stock on hand.",
    tips: ["Controlled drugs are marked — they're tracked in the controlled register report."],
  },
  "/pharmacy/batches": {
    title: "Batches & expiry",
    purpose: "Every stock batch with its expiry and quantity — the place to adjust stock or quarantine a bad lot.",
    columns: [
      { name: "Batch", desc: "The lot number." },
      { name: "Expiry", desc: "When the batch expires. Near-expiry and expired are highlighted." },
      { name: "Qty on hand", desc: "Units currently available from this batch." },
      { name: "Status", desc: "ok · near_expiry · expired · quarantine." },
    ],
    sections: [{ h: "Adjust / quarantine", body: "Use adjust to correct a count (with a reason); quarantine to block a suspect batch from being dispensed without deleting it." }],
  },
  "/pharmacy/dashboard": {
    title: "Pharmacy dashboard",
    purpose: "The pharmacy manager's overview — value on hand, dispensing trend, and what needs attention.",
    sections: [{ h: "Alerts", body: "Low-stock, near-expiry, expired, and open purchase orders surface here so nothing is missed." }],
  },
  "/pharmacy/admin/catalog": {
    title: "Catalog admin",
    purpose: "Add and edit drugs (name, form, class, price, reorder level) — the manager's catalog control.",
  },
  "/pharmacy/purchasing": {
    title: "Purchasing",
    purpose: "Suppliers and purchase orders — order stock, then receive it into inventory.",
    sections: [
      { h: "The PO lifecycle", body: "Create a PO (draft) → mark it Ordered → when stock arrives, Receive it. Receiving creates a batch per line and increases stock on hand." },
    ],
    tips: ["Receiving is one-time per PO — once received it can't be received again."],
  },
  "/pharmacy/stock-control": {
    title: "Stock control",
    purpose: "Physical stock counts — reconcile what's on the shelf against what the system thinks.",
    sections: [
      { h: "A count session", body: "Start a count (snapshots current on-hand) → enter the counted number per drug → the variance shows → Adjust to reconcile → Approve to close." },
    ],
  },
  "/pharmacy/reports": {
    title: "Pharmacy reports",
    purpose: "Operational and financial reports — view on screen or export to CSV.",
    sections: [{ h: "Available reports", body: "Consumption, Margins, Wastage/expiry, Controlled register, Stock valuation, Supplier performance." }],
  },

  // ---- Front office / clinical (starter coverage) ----
  "/reception": {
    title: "Reception",
    purpose: "Register the visit, take the card fee, and route the patient to triage or straight to a doctor.",
    sections: [
      { h: "Patient & card", body: "Find the patient, then settle the card / consultation fee." },
      { h: "Route patient", body: "Pick the department and whether they go to Triage first or Straight to doctor, then send them into the queue." },
    ],
  },
  "/triage": {
    title: "Triage",
    purpose: "Record vitals before the doctor sees the patient.",
    tips: ["Vitals you record here appear on the doctor's encounter."],
  },
  "/worklist": {
    title: "My day",
    purpose: "The doctor's board of their own patients, across four tabs.",
    sections: [
      { h: "Waiting", body: "Patients in the queue assigned to you — Open consult to start." },
      { h: "In progress", body: "Encounters you've opened, with the reason they're parked (e.g. ‘Awaiting lab (2)’). Resume to continue." },
      { h: "Appointments", body: "Your upcoming booked appointments." },
      { h: "Done today", body: "Encounters you've signed and closed today." },
    ],
  },
  "/patients": {
    title: "Patients",
    purpose: "Find and open patient records, or register a new patient.",
    sections: [{ h: "Search", body: "Search by name or MRN. The system warns about likely duplicates when you register, to avoid double records." }],
  },
  "/patients/new": {
    title: "Register patient",
    purpose: "Create a new patient record — demographics, contact, and any known allergies/conditions.",
    tips: ["Recording allergies here powers the prescribing & dispensing safety checks later.", "An MRN is assigned automatically."],
  },
  "/patients/:id": {
    title: "Patient profile",
    purpose: "Everything about one patient — demographics, allergies & conditions, attachments, and visit history.",
    sections: [{ h: "Allergies & conditions", body: "Kept here and shown as alerts on the encounter and at the pharmacy. Keep them current." }],
  },
  "/appointments": {
    title: "Appointments",
    purpose: "Book, reschedule, and check in scheduled visits.",
    sections: [
      { h: "Booking", body: "Pick patient, provider, department and time. The system prevents double-booking the same provider or resource." },
      { h: "Check-in", body: "When the patient arrives, check them in to drop them into the queue for triage or the doctor." },
    ],
    tips: ["A doctor-booked follow-up within the clinic's window is free of the card fee."],
  },
  "/queue": {
    title: "Queue",
    purpose: "The live department queue — who's waiting and at what stage. Updates in real time.",
    sections: [
      { h: "Moving patients", body: "Call → Start → Complete as the patient progresses. Assign a patient to a specific doctor so they show on that doctor's My-day board." },
    ],
  },
  "/encounter/:id": {
    title: "Consultation",
    purpose: "The doctor's workspace for one visit — notes, diagnosis, prescription, lab orders, and sign-off.",
    sections: [
      { h: "Banner", body: "Patient identity + allergy alerts (red) so safety risks are always visible." },
      { h: "SOAP note", body: "Subjective / Objective / Assessment / Plan — auto-saved as you type until you sign." },
      { h: "Diagnosis", body: "Search the ICD-10 catalog; the first one you add is the primary diagnosis." },
      { h: "Prescription", body: "Add medications — blocked if the drug conflicts with a recorded allergy (class-aware)." },
      { h: "Orders / Lab", body: "Order tests (available ones only) and see results return inline, with critical values called out." },
      { h: "Set aside vs Sign & close", body: "‘Set aside’ parks the visit while labs run (stays editable, shows on your board). ‘Sign & close’ locks it." },
    ],
  },

  // ---- Lab ----
  "/lab": {
    title: "Lab worklist",
    purpose: "The bench worklist — collect samples, enter results, and pass them for validation.",
    columns: [
      { name: "Sample", desc: "Sample number (S-####) — also what the scan box looks up." },
      { name: "Test / Patient / Priority", desc: "What to run, for whom, and how urgent (STAT sorts to the top)." },
      { name: "Status", desc: "ordered → collected → resulted → validated." },
    ],
    sections: [
      { h: "The tabs", body: "To collect (accession the sample) · Result entry (type values) · Awaiting validation · Validated (done)." },
      { h: "Scan box", body: "Scan or type a sample number and press Enter to jump straight to it." },
    ],
  },
  "/lab/inbox": {
    title: "Results inbox",
    purpose: "Results that came back for your patients. Critical values are pinned and need acknowledgement.",
    sections: [{ h: "Criticals", body: "A red badge in the sidebar counts unacknowledged criticals. Open one, review, then ‘Mark notified’ to record that you were told." }],
  },
  "/lab/catalog": {
    title: "Lab test catalog",
    purpose: "The tests this lab offers and their analytes with reference & critical ranges.",
    sections: [
      { h: "Availability", body: "The Available/Unavailable pill controls whether doctors can order a test. Unavailable tests are hidden from ordering." },
      { h: "Ranges matter", body: "Reference and critical ranges drive auto-flagging — keep them correct so results flag properly." },
    ],
    tips: ["Edit an analyte to fix a range; you can only delete an analyte that has no recorded results."],
  },
  "/lab/items/:id": {
    title: "Sample detail",
    purpose: "One sample — accession it, enter results, validate/release, and acknowledge criticals.",
  },

  // ---- Billing ----
  "/cashier": {
    title: "Cashier",
    purpose: "Pending payments waiting to be collected. Take payment or waive with a reason.",
    sections: [
      { h: "Take payment", body: "Pick the payment method, then 'Take payment' on a charge. The patient is grouped so you can see everything they owe." },
      { h: "Waive", body: "If a patient doesn't pay (staff, charity, exemption), Waive it with a required reason — it's recorded for the finance report." },
      { h: "Auto-advance", body: "Settling (or waiving) a consultation charge sends the patient on to triage / the doctor automatically." },
    ],
    tips: ["This worklist appears for anyone with the Cashier role (the payment.collect permission). Reception without that role sends charges here; a receptionist who also holds the Cashier role collects at the desk instead."],
  },
  "/finance": {
    title: "Finance",
    purpose: "The money view — collected, waived (revenue forgone), and outstanding, with a by-service breakdown.",
    columns: [
      { name: "Collected", desc: "Total taken in the period, across all payment methods." },
      { name: "Waived", desc: "Value waived (free) in the period — your revenue forgone, by reason." },
      { name: "Outstanding", desc: "Charges still pending payment right now." },
    ],
  },
  "/billing/services": {
    title: "Service catalog",
    purpose: "What the clinic bills for, and how much. Prices feed the charges patients pay at the cashier.",
    sections: [
      { h: "Availability", body: "Toggle a service Available/Off to control whether it can be charged. Edit a price any time." },
    ],
  },

  // ---- Administration ----
  "/users": {
    title: "Staff",
    purpose: "Manage staff accounts — invite users, set their roles, and activate/deactivate them.",
    sections: [{ h: "Roles", body: "A user's role decides what they see and can do. Assign roles here; permissions follow the role." }],
  },
  "/settings": {
    title: "Settings",
    purpose: "Configure the clinic — patient-flow rules and the diagnosis catalog.",
    sections: [
      { h: "Patient flow", body: "Set the card / consultation fee and the free-follow-up window (how long a doctor-booked follow-up stays free)." },
      { h: "Diagnosis catalog", body: "The categories and ICD-10 entries doctors pick from. Add your own to match how your clinic codes." },
    ],
  },
};

const ENTRIES = Object.entries(HELP);

/** Match a concrete pathname to its help entry (handles :id segments). */
export function helpForPath(pathname: string): HelpEntry | undefined {
  if (HELP[pathname]) return HELP[pathname];
  const parts = pathname.split("/");
  for (const [key, entry] of ENTRIES) {
    const kp = key.split("/");
    if (kp.length !== parts.length) continue;
    if (kp.every((seg, i) => seg.startsWith(":") || seg === parts[i])) return entry;
  }
  return undefined;
}

/** Help entry for a nav route (exact key), for building the Help Center list. */
export function helpForRoute(route: string): HelpEntry | undefined {
  return HELP[route];
}
