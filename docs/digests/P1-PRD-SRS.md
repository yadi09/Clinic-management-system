I have now read all 1079 lines. Below is the complete digest.

---

# Clinic Management SaaS Platform — Part 1 Digest (Executive Summary, BA, PRD, SRS)

Source: `/tmp/clinic-docs/Clinic_SaaS_Blueprint_Part-1.md` (1079 lines, fully read). Document status: "Implementation-ready draft v3". Product type: Cloud-native, multi-tenant Clinic Management SaaS. Architecture: **modular monolith, microservice-ready**.

## Mandated Technology Stack

| Layer | Technology | Rationale / Use |
| --- | --- | --- |
| Frontend | React, TypeScript, Vite, React Router, TanStack Query, TailwindCSS, ShadCN UI, React Hook Form, Zod | Type-safe SPA, server-state caching, accessible primitives |
| Backend | Go (Gin), SQLC, PostgreSQL, Redis, RabbitMQ | Compiled high-throughput services; compile-time-checked SQL; relational store; caching; async messaging |
| Storage | S3-compatible object storage | Medical documents, lab reports, images |
| Search | OpenSearch | Full-text patient/record search + analytics indexing |
| Delivery / Ops | Docker, Kubernetes, GitHub Actions; Prometheus, Grafana, Loki | Containerised orchestrated deploy, CI/CD, observability |

**Where specific stack components are invoked (load-bearing):**
- **PostgreSQL** — durable relational store; SQLC mandates all SQL compile-time-checked (NFR-23). Hot tables MUST be partitionable by tenant and/or time (NFR-07).
- **Redis** — caching layer; staged-scaled alongside PG/broker/search (Strategic obj 1.3; NFR-05).
- **RabbitMQ** — async messaging for notifications, indexing, report generation (4.2.1, 4.4.3, FR-NOT-02). Jobs MUST retry with backoff + dead-letter (NFR-09).
- **OpenSearch** — full-text patient/record search + analytics indexing; "optional dependency" that core MUST tolerate being unavailable (NFR-10).
- **S3-compatible storage** — files/attachments (PDF, images, scans), lab reports; storage limits gated by plan; primary storage-growth driver (Table 4.2).
- **Kubernetes** — Linux containers orchestrated; cloud-agnostic deploy (NFR-24); stateless horizontally-scalable API instances behind LB (NFR-06).

## System Context (Figure 4.1)
`Web SPA / API Clients → API Gateway / Gin Services → PostgreSQL + Redis → RabbitMQ Workers → OpenSearch + Object Storage`

---

## 1. Executive Summary — Key Facts

- **Vision:** Onboard a solo practice in minutes; scale to tens of thousands of clinics with no re-architecture. Guiding principle: "start small, scale easily." Same codebase for solo doctor and 40-branch group — difference is configuration, subscription tier, and feature flags.
- **Differentiators:** (1) JSON-schema-driven medical form builder per specialty (no code changes); (2) true multi-tenancy with branch scoping (resolves by tenant/branch/department); (3) configurable not custom; (4) microservice-ready monolith (can extract Laboratory, Pharmacy, or Billing under load); (5) standards-based interop — LIS built around **HL7, FHIR, ASTM**.
- **Commercial model:** 4 tiers — **Starter, Professional, Business, Enterprise** — differentiated by user/branch/storage limits + unlocked modules.

### Success Criteria (Table 1.4) — headline targets
| Dimension | Target |
| --- | --- |
| Tenant onboarding | < 15 minutes self-service to first patient registered |
| Core API latency | p95 < 300 ms reads, < 600 ms writes |
| Availability | 99.9% monthly uptime |
| Tenant isolation | Zero cross-tenant data exposure; enforced at query + policy layers |
| Scale path | 100 → 1,000 → 10,000 clinics, no app rewrite |
| Auditability | 100% of clinical + financial mutations in immutable audit log |

### Target Segments (Table 1.1)
| Segment | Typical Scale | Primary Need |
| --- | --- | --- |
| Small Clinics | 1 branch, 3–10 staff, 50–150 visits/day; 1–3 providers | Fast onboarding, appointments, EMR, simple billing |
| Medium Clinics | 1–3 branches, 15–120 staff, 150–600 visits/day | Lab + pharmacy integration, queueing, insurance, reporting |
| Multi-Branch | 4–40+ branches, 120–1,500+ staff | Central admin, branch-scoped access, consolidated finance/analytics |

---

## 2. Business Analysis

### Stakeholders (Table 2.1) — Platform-side vs Tenant-side vs External
- **Vendor:** Platform Super Admin (uptime, churn), SaaS Support Admin (impersonate with consent; CSAT/TTR).
- **Clinic:** Tenant Owner, Clinic Administrator, Branch Manager, Receptionist/Front Desk, Doctor/Provider, Nurse, Lab Technician/Manager, Pharmacist/Pharmacy Manager, Cashier/Accountant, Inventory/HR Manager.
- **External:** Patient, Insurance Provider/Payer, Regulator/Auditor.

### Canonical Patient Flow (Figure 2.1)
`Register → Appointment → Queue → Triage/Vitals → Consultation → Orders (Lab/Rx) → Results → Diagnosis → Billing → Payment → Pharmacy → Follow-up`

### Multi-Branch Operational Model (2.8.2)
- Central admin defines shared catalogues (services, drugs, lab tests) + price lists; branches inherit, with branch-level overrides where allowed.
- Branch Managers scoped to their branch only. Inventory transfers move stock between central store and branches.
- **One MRN per tenant** — patients shared across branches; records follow the patient. Finance consolidates revenue across branches while preserving per-branch P&L.

### Specialty Matrix (Table 2.3) — drives default form template + EMR config (no code fork)
| Specialty | Distinctive Workflow | Key Forms/Data | Module Needs |
| --- | --- | --- | --- |
| General Medicine | Broad triage; baseline config | Chief complaint, vitals, SOAP, basic labs | Lab, Pharmacy, Billing |
| Internal Medicine | Chronic mgmt, longitudinal | Problem list, med reconciliation, trend charts | Lab panels, trending analytics |
| Pediatrics | Growth/immunisation; weight-based dosing | Growth charts, vaccination schedule, age-aware vitals | Vaccination registry, weight-based Rx checks, guardian consent |
| Gynecology | Reproductive/antenatal; sensitive | Menstrual/obstetric history, antenatal forms, EDD calculator | Heightened privacy controls, scheduling cycles |
| Dermatology | Visual dx; lesion tracking | Body-map annotations, lesion photos, biopsy orders | Image storage, photo comparison, Lab (histopath) |
| Dental | Tooth-level charting; procedure-heavy | Odontogram, periodontal chart, treatment plan, per-procedure consent | Procedure catalogue, per-tooth/per-procedure billing, imaging |
| ENT | Endoscopic exams; audiology | ENT exam fields, audiogram, endoscopy note | Procedure notes, device/image attachments |
| Orthopedics | Imaging-driven; fracture/post-op | ROM/strength exam, imaging refs, fracture notes | PACS/imaging refs, follow-up tracking |
| Cardiology | Diagnostics-heavy; risk strat | ECG/echo results, BP trends, risk scores | Device/result integration, trend analytics |
| Ophthalmology | Per-eye measurements; optical Rx | Visual acuity, IOP, refraction (OD/OS), fundus | Per-eye fields, optical Rx, imaging |

Realised via: (a) default form-template set at clinic/department setup, (b) optional EMR sections (odontogram, growth chart, per-eye fields), (c) module enablement.

---

## 3. PRD

### Personas (Table 3.1)
Dr. Owner (solo, tablet), Clinic Admin (medium/3-doctor polyclinic), Front-Desk Rana (200 patients/day), Dr. Provider, Nurse Maya (triage/vitals), Lab Tech Sam, Pharmacist Omar, Accountant Lina (clinic group), Branch Manager Ken, Tenant Owner (group), Patient Portal User.

### Subscription Plans & Limits (Table 3.2) — limits are DATA, not code; enforced on create/activate ops, block with upgrade prompt
| Capability / Limit | Starter | Professional | Business | Enterprise |
| --- | --- | --- | --- | --- |
| Branches | 1 | Up to 3 | Up to 10 | Unlimited (fair-use) |
| Active staff users | Up to 5 | Up to 25 | Up to 100 | Unlimited (fair-use) |
| Object storage | 5 GB | 50 GB | 500 GB | Custom |
| Patient records | Unlimited | Unlimited | Unlimited | Unlimited |
| Core (Auth, Patients, Appointments, Queue, Consultation/EMR, Billing) | Included | Included | Included | Included |
| Laboratory | — | Optional | Included | Included |
| Pharmacy | — | Optional | Included | Included |
| Inventory | — | Optional | Included | Included |
| Insurance | — | — | Optional | Included |
| Telemedicine | — | — | Optional | Optional |
| HR | — | — | Optional | Included |
| Finance (advanced) | Basic | Basic | Included | Included |
| Reporting & Analytics | Basic | Standard | Advanced | Advanced + custom |
| Audit log retention | 90 days | 1 year | 3 years | Configurable |
| API access | — | Read-only | Full | Full + higher rate limits |
| MFA enforcement | Optional | Optional | Enforced option | Enforced |
| Support | Community | Email | Priority | Dedicated / SLA |

"Optional" = paid add-on feature flag on that tier.

### Feature Flags (Table 3.3) — resolved per tenant (and per branch where relevant). Resolution order: **plan defaults → tenant add-ons → explicit admin overrides**. Frontend hides disabled modules; backend rejects disabled-module endpoints with recoverable error.
| Flag | Controls | Default by Plan |
| --- | --- | --- |
| `pharmacy` | Pharmacy module & dispensing | Off ≤ Pro (optional), On ≥ Business |
| `laboratory` | LIS module | Off ≤ Pro (optional), On ≥ Business |
| `inventory` | Inventory & transfers | Off ≤ Pro (optional), On ≥ Business |
| `insurance` | Insurance & claims | Off ≤ Business (optional), On Enterprise |
| `telemedicine` | Video consultation | Off (optional on Business+) |
| `hr` | HR module | Off (optional on Business), On Enterprise |
| `finance_advanced` | Advanced finance & reporting | On ≥ Business |

### 31-Module Catalogue (Table 3.4) — "Core" = all tiers; lowercase = gating flag; "Platform" = vendor-only
| # | Module | Purpose | Tier/Flag |
| --- | --- | --- | --- |
| 1 | Authentication | Login, tokens, MFA, sessions | Core |
| 2 | User Management | Staff accounts, invitations, lifecycle | Core |
| 3 | Role Management | Roles, permissions, scope assignment | Core |
| 4 | Tenant Management | Tenant lifecycle, plans, subscription billing | Platform |
| 5 | Clinic Management | Clinic profile, settings, module enablement | Core |
| 6 | Branch Management | Branches under tenant, branch settings | Core |
| 7 | Department Management | Departments/specialties within branches | Core |
| 8 | Patient Registration | Create/maintain records & MRN | Core |
| 9 | Patient Search | Fast dedup search across identifiers | Core |
| 10 | Appointment Management | Booking, rescheduling, reminders | Core |
| 11 | Queue Management | Live queues per department/branch | Core |
| 12 | Consultation | Encounter workflow tying EMR together | Core |
| 13 | EMR | Electronic medical record container | Core |
| 14 | Medical History | Longitudinal history & timeline | Core |
| 15 | Clinical Notes | SOAP/progress notes | Core |
| 16 | Vitals | Vital sign capture & trends | Core |
| 17 | Diagnoses | ICD-coded diagnoses | Core |
| 18 | Procedures | Procedure recording & catalogue | Core |
| 19 | Prescriptions | e-Prescribing with safety checks | Core |
| 20 | Laboratory (LIS) | Tests, samples, results, approval | `laboratory` |
| 21 | Pharmacy | Drug catalogue, dispensing, batches | `pharmacy` |
| 22 | Inventory | Stock, transfers, purchasing | `inventory` |
| 23 | Billing | Charge capture across services | Core |
| 24 | Invoicing | Invoice generation & lifecycle | Core |
| 25 | Payments | Payment capture, refunds, receipts | Core |
| 26 | Insurance | Providers, plans, claims, reimbursement | `insurance` |
| 27 | Notifications | Email/SMS/in-app/push delivery | Core |
| 28 | Reporting | Operational & financial reports | Core/Advanced |
| 29 | Analytics | Dashboards & KPIs | Core/Advanced |
| 30 | Audit Logs | Immutable change & access logging | Core |
| 31 | Settings | Tenant/branch/user configuration | Core |

### Tenant Lifecycle State Machine (Figure 3.1 / Table 3.5)
`Created → Onboarding → Active → Suspended → Cancelled`
| State | Meaning | Access | Trigger to Next |
| --- | --- | --- | --- |
| Created | Tenant exists; signup begun | Owner can complete onboarding | Onboarding wizard started |
| Onboarding | Configuring clinic/branch/staff | Limited; setup screens only | Onboarding completed & plan confirmed |
| Active | Operating normally | Full per plan & flags | Payment failure / admin action |
| Suspended | Temporarily disabled (e.g. billing) | Read-only or blocked; data retained | Payment resolved → Active; or → Cancelled |
| Cancelled | Subscription ended | Blocked; data retained per policy then purged | Reactivation (new cycle) or purge |
Transitions are auditable and drive access.

### RBAC — 17 Roles (3.7.1)
Platform Super Admin, SaaS Support Admin, Tenant Owner, Clinic Administrator, Branch Manager, Receptionist, Doctor, Nurse, Laboratory Technician, Laboratory Manager, Pharmacist, Pharmacy Manager, Cashier, Accountant, Inventory Manager, HR Manager, Patient Portal User. (Full CRUD matrix in Part 2.)

### Scoping Rules (3.7.2) — authz resolves on 3 axes: **role (what) + scope (tenant→branch→department) + module flag (enabled?)**
- Platform roles operate above tenants (vendor side); never appear inside tenant data views.
- Tenant Owner + Clinic Administrator are tenant-wide (all branches/departments).
- Branch Manager + operational roles are branch-scoped (assigned branch(es) only).
- Clinical roles may be further department-scoped (e.g., doctor restricted to specialty dept).
- Patient Portal User sees only own/dependents' records.
- Every authz check is also gated by the relevant module feature flag.

### Anchor User Stories (Table 3.6)
US-01 self-onboard + first appointment; US-02 dedup search (phone/MRN/national ID, fuzzy match warns before create); US-03 add to department queue (real-time); US-04 encounter view (timeline/vitals/allergies one screen); US-05 specialty SOAP template; US-06 Rx safety checks (allergy, peds weight-based); US-07 lab result states `entered → validated → approved`; US-08 batch/expiry blocks expired/insufficient; US-09 aggregate consult+lab+pharmacy to one invoice; US-10 consolidated revenue + drill-down; US-11 branch-scoped data; US-12 module toggle hides/shows immediately; US-13 portal booking + results after approval; US-14 immutable audit trail; US-15 no-code drag-drop form, versioned, assignable.

### KPIs (Table 3.7)
| Category | KPI | Target |
| --- | --- | --- |
| Adoption | Time to first patient registered | < 15 minutes |
| Adoption | Trial-to-paid conversion | ≥ 25% |
| Engagement | Weekly active staff / licensed users | ≥ 70% |
| Operations | Avg front-desk registration time | < 90 seconds |
| Operations | Avg patient wait (queue) reduction vs baseline | ≥ 20% |
| Clinical | Encounters with complete documentation | ≥ 95% |
| Lab | Result turnaround (collection → approved) | Tracked; improving trend |
| Pharmacy | Expired-stock write-off rate | Declining MoM |
| Finance | Billed-vs-rendered service capture | ≥ 99% |
| Reliability | Core platform availability | ≥ 99.9% monthly |
| Retention | Net revenue retention | ≥ 110% |

### Assumptions / Constraints / Dependencies (3.10)
- **Assumptions:** reliable internet during hours (brief offline tolerance desirable, not launch req); tenants accept shared configurable codebase; **ICD** for diagnoses; drug/lab catalogues seeded + tenant-extendable.
- **Constraints:** mandated stack; modular monolith w/ microservice-ready boundaries; HIPAA/GDPR-inspired privacy (not a substitute for tenant's legal compliance).
- **Dependencies:** Email/SMS providers; payment gateway(s); S3-compatible storage + OpenSearch (managed or self-hosted); optional lab analysers supporting **HL7/ASTM**.

### Out of Scope (MVP) (3.11)
Inpatient/ward + OR scheduling; native mobile apps (responsive web at launch); AI notes/Rx assist/predictive analytics; PACS/RIS + national health-system integrations; third-party marketplace.

### Release Phasing (Table 3.8)
| Phase | Theme | Headline Scope |
| --- | --- | --- |
| 1 | MVP | Auth, tenants, patients, appointments, queue, consultation/EMR, basic billing |
| 2 | Operational Clinic | Lab, Pharmacy, Inventory, full billing/payments, notifications, reporting |
| 3 | Multi-Branch | Branch scoping, transfers, consolidated finance & analytics, insurance |
| 4 | Advanced SaaS | Form builder maturity, advanced analytics, API platform, telemedicine option |
| 5 | Enterprise Expansion | AI features, mobile, PACS/RIS, national integrations, marketplace |

Priority legend: MUST = mandatory for introducing phase; SHOULD = strongly desired; MAY = optional.

---

## 4. SRS — Functional Requirements (FR-*)

ID scheme: `FR-<MODULE>-<n>` (functional), `NFR-<n>` (non-functional).

### Authentication (FR-AUTH)
- **FR-AUTH-01** (MUST): email/username + password auth; issue **short-lived access token + refresh token**.
- **FR-AUTH-02** (MUST): refresh-token rotation; revoke prior refresh token on each rotation.
- **FR-AUTH-03** (MUST): optional MFA (**TOTP**) per user; tenants MAY enforce MFA for all staff.
- **FR-AUTH-04** (MUST): lock account after configurable failed attempts; log event.
- **FR-AUTH-05** (MUST): password reset via time-limited single-use token by email.
- **FR-AUTH-06** (MUST): invalidate all sessions on password change + on logout-all.
- **FR-AUTH-07** (SHOULD): SaaS Support Admin impersonation only with recorded, consented authorisation, fully audited.

### User / Role / Tenant (FR-USR / FR-ROLE / FR-TEN)
- **FR-USR-01** (MUST): invite staff by email; complete signup via time-limited link.
- **FR-USR-02** (MUST): user lifecycle states — **invited, active, suspended, deactivated**.
- **FR-USR-03** (MUST): enforce plan active-user limit; block activation beyond it w/ upgrade prompt.
- **FR-ROLE-01** (MUST): provide the **17 predefined roles**; assign role + scope (branch/department) per user.
- **FR-ROLE-02** (SHOULD): custom roles by composing permissions (**Business+**).
- **FR-TEN-01** (MUST): tenant lifecycle states (Created, Onboarding, Active, Suspended, Cancelled) w/ audited transitions.
- **FR-TEN-02** (MUST): enforce subscription limits (branches, users, storage) per active plan.
- **FR-TEN-03** (MUST): evaluate feature flags from plan defaults/add-ons/overrides; reject disabled-module calls w/ recoverable error.
- **FR-TEN-04** (MUST): retain tenant data on suspension; apply configured retention policy on cancellation before purge.

### Clinic / Branch / Department (FR-CLN / FR-BR / FR-DEP)
- **FR-CLN-01** (MUST): tenant configures clinic profile, locale, time zone, enabled modules.
- **FR-BR-01** (MUST): multiple branches per tenant within plan limits; each w/ own address, hours, resources.
- **FR-BR-02** (MUST): shared catalogues (services, drugs, tests, forms) defined centrally w/ optional branch overrides.
- **FR-DEP-01** (MUST): departments within a branch, each linked to a specialty + default form-template set.
- **FR-DEP-02** (MUST): assign providers + resources (rooms) to departments for scheduling/queueing.

### Patient Registration & Search (FR-PAT)
- **FR-PAT-01** (MUST): patient record — identity, demographics, contact, emergency contact, insurance details (fields in Part 2).
- **FR-PAT-02** (MUST): unique **MRN per tenant**; prevent duplicate MRNs.
- **FR-PAT-03** (MUST): duplicate detection on create using **name, DOB, phone, national ID**; warn before save.
- **FR-PAT-04** (MUST): fast search by name, MRN, phone, national ID, or passport; tenant-scoped results.
- **FR-PAT-05** (MUST): guardian/dependent linkage for minors + shared accounts.
- **FR-PAT-06** (MUST): clinical summary (allergies, chronic conditions, family history, vaccination history); surface allergies prominently at point of care.
- **FR-PAT-07** (MUST): attach documents (PDF, images, reports, scans) w/ type + date metadata.
- **FR-PAT-08** (MUST): share patient identity across branches (one MRN/tenant); scope operational visibility by role.

### Appointments & Queue (FR-APT / FR-QUE)
- **FR-APT-01** (MUST): book against provider/department/resource slot; prevent double-booking same resource.
- **FR-APT-02** (MUST): reschedule + cancel w/ reason capture + full history.
- **FR-APT-03** (SHOULD): configurable email/SMS reminders.
- **FR-APT-04** (SHOULD): online self-booking via portal, constrained to published availability.
- **FR-QUE-01** (MUST): live queue per department/branch; states **waiting, called, in-consult, done, no-show**.
- **FR-QUE-02** (MUST): near-real-time queue updates for staff + optional display screens.
- **FR-QUE-03** (SHOULD): priority/triage ordering overriding arrival order w/ audit reason.

### Consultation & EMR (FR-CON / FR-EMR)
- **FR-CON-01** (MUST): create encounter on consultation entry; link to provider, department, queue entry.
- **FR-CON-02** (MUST): encounter view shows history timeline, active problems, allergies, current meds, latest vitals on one screen.
- **FR-EMR-01** (MUST): capture SOAP + progress notes; **immutable once signed** (amendments tracked).
- **FR-EMR-02** (MUST): record diagnoses with **ICD codes**, procedures, referrals, follow-up instructions per encounter.
- **FR-EMR-03** (MUST): vitals w/ units + timestamps; chart trends.
- **FR-EMR-04** (MUST): specialty-specific EMR sections (odontogram, growth chart, per-eye fields) by department config.
- **FR-EMR-05** (MUST): link orders (lab tests, prescriptions) + results back to originating encounter.
- **FR-EMR-06** (MUST): complete chronological history across all patient encounters within tenant.

### Prescriptions (FR-RX)
- **FR-RX-01** (MUST): create Rx w/ drug, dose, route, frequency, duration, instructions from drug catalogue.
- **FR-RX-02** (MUST): check against recorded allergies; surface warnings before signing.
- **FR-RX-03** (SHOULD): weight-based dosing aids for pediatrics; flag out-of-range doses.
- **FR-RX-04** (MUST): signed Rx available to Pharmacy module when enabled, otherwise printable/exportable.

### Medical Form Builder (FR-FRM)
- **FR-FRM-01** (MUST): drag-and-drop builder producing **versioned JSON schema**.
- **FR-FRM-02** (MUST): field types — **text, text area, number, date, time, checkbox, radio, dropdown, multi-select, file upload, signature**.
- **FR-FRM-03** (MUST): conditional fields, validation rules, templates, form cloning.
- **FR-FRM-04** (MUST): version forms; existing records retain capture-time schema version.
- **FR-FRM-05** (MUST): role/department restrictions on who can complete a form.
- **FR-FRM-06** (MUST): default templates for at least **General Medicine, Pediatrics, Gynecology, Dental, Dermatology**.

### Laboratory / LIS (FR-LAB)
- **FR-LAB-01** (MUST): test catalogue — test groups, specimen types, units, reference ranges.
- **FR-LAB-02** (MUST): capture lab orders from encounter; generate sample collection records w/ tracking IDs.
- **FR-LAB-03** (MUST): sample status — **ordered, collected, received, in-process, resulted**.
- **FR-LAB-04** (MUST): result entry via manual, CSV import, device integration.
- **FR-LAB-05** (MUST): result lifecycle **entered → validated → approved** w/ role-gated transitions.
- **FR-LAB-06** (MUST): result reports; approved results available to ordering provider + (when permitted) patient portal.
- **FR-LAB-07** (SHOULD): **HL7, FHIR, ASTM** interfaces for device/external-lab integration.

### Pharmacy (FR-PHA)
- **FR-PHA-01** (MUST): drug catalogue — classification, form, strength, units.
- **FR-PHA-02** (MUST): track stock by **batch with expiry**; prevent dispensing expired/insufficient stock.
- **FR-PHA-03** (MUST): dispensing against prescription + OTC sales.
- **FR-PHA-04** (MUST): suppliers, purchase orders, goods receiving, returns.
- **FR-PHA-05** (SHOULD): low-stock + near-expiry alerts on configurable thresholds.
- **FR-PHA-06** (MUST): dispensing creates billable charges linked to patient's visit when applicable.

### Inventory (FR-INV)
- **FR-INV-01** (MUST): track stock at central + branch levels w/ on-hand quantities + valuation.
- **FR-INV-02** (MUST): inter-branch transfers w/ dispatch + receipt confirmation.
- **FR-INV-03** (MUST): purchase requests, purchase orders, goods receiving.
- **FR-INV-04** (MUST): stock counts + audits w/ variance reporting.

### Billing / Invoicing / Payments (FR-BIL / FR-INVC / FR-PAY)
- **FR-BIL-01** (MUST): aggregate charges from consultation, lab, pharmacy, procedures into visit bill.
- **FR-BIL-02** (MUST): package billing, discounts (w/ authorisation), price lists per branch.
- **FR-INVC-01** (MUST): generate invoices w/ line items, taxes, totals; invoice lifecycle **draft, issued, paid, void**.
- **FR-PAY-01** (MUST): capture payments (cash, card, gateway where configured), partial payments, receipts.
- **FR-PAY-02** (MUST): refunds w/ reason capture + audit.
- **FR-PAY-03** (MUST): reconcile payments to invoices; daily cash-up/closure reporting.

### Insurance (FR-INS)
- **FR-INS-01** (MUST): insurance providers + coverage plans w/ covered services + co-pay rules.
- **FR-INS-02** (MUST): record patient insurance; apply coverage to eligible charges at billing time.
- **FR-INS-03** (MUST): claim lifecycle **prepared → submitted → approved/rejected → reimbursed** w/ status history.
- **FR-INS-04** (SHOULD): reimbursement tracking + reconciliation against submitted claims.

### Notifications / Reporting / Analytics / Audit / Settings (FR-NOT / FR-REP / FR-ANL / FR-AUD / FR-SET)
- **FR-NOT-01** (MUST): deliver via email, SMS, in-app; push as extension point.
- **FR-NOT-02** (MUST): async sending via message broker (RabbitMQ) w/ retry + failure logging.
- **FR-REP-01** (MUST): role-appropriate operational + financial reports w/ filters; export CSV/PDF.
- **FR-ANL-01** (MUST): per-role dashboards (reception, doctor, nurse, lab, pharmacy, finance, management) w/ KPIs + charts.
- **FR-ANL-02** (MUST): multi-branch consolidated analytics w/ drill-down to single branch.
- **FR-AUD-01** (MUST): immutable audit entry for every create/update/delete on clinical + financial data + sensitive reads.
- **FR-AUD-02** (MUST): audit captures **actor, tenant, branch, action, target, timestamp, source IP**; tamper-evident.
- **FR-SET-01** (MUST): tenant-, branch-, user-level settings (locale, notifications, security policy, catalogues).

---

## 4.4 External Interfaces
- **UI:** responsive React SPA (ShadCN + Tailwind), desktop/tablet/mobile; explicit loading/empty/error states; **WCAG 2.1 AA**.
- **Software:** REST over HTTPS/JSON primary surface; Email/SMS APIs behind provider abstraction; payment gateway APIs (tenant-enabled); S3-compatible storage API; OpenSearch API; LIS over **HL7/FHIR/ASTM**.
- **Communication:** **TLS 1.2+** all external traffic; internal cluster traffic encrypted; async messaging via **RabbitMQ** (notifications, indexing, report generation).
- **API conventions:** resource-oriented URLs, standard HTTP verbs, consistent error envelopes w/ machine-readable codes; cursor or offset pagination, filtering, sorting, search standardised across list endpoints; every request carries tenant context from authenticated principal — cross-tenant access impossible by contract. (No literal endpoint paths are specified in Part 1; full API contracts are deferred to Part 2.)

## 4.5 Non-Functional Requirements (NFR-*)

**Performance:** NFR-01 read p95 < 300 ms · NFR-02 write p95 < 600 ms · NFR-03 patient search p95 < 400 ms · NFR-04 queue state propagation < 2 s end-to-end.

**Scalability:** NFR-05 scale 100 → 1,000 → 10,000 clinics, no app rewrite (staged scaling of data/cache/broker/search/storage) · NFR-06 horizontally scalable stateless API behind LB (linear scale-out) · NFR-07 hot tables partitionable by tenant and/or time (no redesign at scale).

**Availability & Reliability:** NFR-08 ≥ 99.9% monthly availability · NFR-09 async jobs retried w/ backoff, dead-lettered on persistent failure (no silent loss) · NFR-10 graceful degradation when optional dependency (search, SMS) unavailable (core unaffected) · NFR-11 **RPO ≤ 15 min, RTO ≤ 1 h** (tested; detailed in DevOps part).

**Security & Privacy:** NFR-12 encryption in transit (**TLS 1.2+**) + at rest (**AES-256**) · NFR-13 authz enforces role + scope (tenant/branch/department) + module flag on every protected op (zero cross-scope access) · NFR-14 secrets in secrets manager, none in source (0 secrets in repo) · NFR-15 immutable tamper-evident audit trail (100% coverage) · NFR-16 HIPAA/GDPR-inspired controls: least-privilege, data export, right-to-erasure subject to clinical retention law · NFR-17 sessions expire on inactivity + support revocation; **default ≤ 15 min access token** (configurable).

**Usability:** NFR-18 first-patient-registered < 15 min via guided onboarding · NFR-19 common tasks minimal clicks + keyboard (registration < 90 s) · NFR-20 WCAG 2.1 AA · NFR-21 localisation (locale, time zone, date/number formats; i18n-ready).

**Maintainability & Portability:** NFR-22 explicit module boundaries communicating via interfaces/events (no cross-module DB reach-in) · NFR-23 all SQL via **SQLC**; schema changes migration-managed + reversible (versioned migrations) · NFR-24 containerised, deployable to any conformant Kubernetes (cloud-agnostic) · NFR-25 coverage + review gates before merge.

**Compliance & Retention:** NFR-26 audit log retention per plan (90 days → configurable, Table 3.2) · NFR-27 on cancellation, retain for grace period then securely purge (policy-driven) · NFR-28 clinical records honour minimum legal retention before erasure (law-aware).

## 4.6 Data Requirements

### Logical Data Domains & Key Entities (Table 4.1)
| Domain | Key Entities |
| --- | --- |
| Platform/Tenancy | Tenant, Subscription/Plan, FeatureFlag, BillingAccount |
| Org structure | Clinic, Branch, Department, Resource/Room |
| Identity & access | User, Role, Permission, UserRoleScope, Session, AuditLog |
| Patient | Patient, GuardianLink, PatientInsurance, Allergy, Condition, Attachment |
| Scheduling | Appointment, Slot, QueueEntry |
| Clinical | Encounter, ClinicalNote, Vital, Diagnosis, Procedure, Referral, FollowUp |
| Forms | FormTemplate, FormVersion, FormSubmission |
| Laboratory | Test, TestGroup, LabOrder, Sample, Result |
| Pharmacy | Drug, Batch, Supplier, PurchaseOrder, GoodsReceipt, Dispense, Return |
| Inventory | InventoryItem, StockLevel, Transfer, StockCount |
| Finance | Charge, Invoice, InvoiceLine, Payment, Refund, PriceList, Discount |
| Insurance | InsuranceProvider, CoveragePlan, Claim, Reimbursement |
| Platform services | Notification, Report, AnalyticsSnapshot, Setting |

### Tenant Isolation (4.6.2)
- Every tenant-owned row carries non-null tenant identifier; all queries filter by authenticated tenant.
- Data-access layer applies tenant (and branch where relevant) predicates **centrally** so individual queries cannot omit them.
- Cross-tenant joins impossible by construction in the repository layer.

### Soft Delete & Audit Strategy (4.6.3)
- Clinical + financial records use **soft delete (`deleted_at`)**, never physical deletion.
- Every mutating op emits an append-only audit entry (FR-AUD-01/02).
- Signed clinical notes immutable; corrections = tracked amendments, never overwrites.

### Data Volume Assumptions (Table 4.2)
| Phase | Clinics | Indicative Daily Encounters | Storage Growth Driver |
| --- | --- | --- | --- |
| A | ~100 | Up to ~30k | Attachments, lab reports |
| B | ~1,000 | Up to ~300k | Attachments, images, audit |
| C | ~10,000 | Up to ~3M | Imaging, audit, analytics snapshots |

## 4.7 Acceptance Criteria Patterns (Given/When/Then, Table 4.3)
- **FR-PAT-03:** matching name+DOB+phone exists → create attempt → surface likely match, require explicit confirmation before save.
- **FR-TEN-03:** lab flag off → any lab endpoint call → recoverable "module disabled" error + UI hides module.
- **FR-LAB-05:** result in "entered" → user w/o validate permission attempts approve → denied + audited, state unchanged.
- **FR-PHA-02:** only available batch expired → dispense attempt → blocked w/ clear reason, no stock deducted.
- **NFR-13:** Branch Manager on Branch A → requests Branch B data → access denied + audited.
- **NFR-08:** one-month window → uptime computed excluding scheduled maintenance → ≥ 99.9%.

## 4.8 Traceability
Every FR-* traces forward to module API contracts + UI screens (Part 2) and to test cases (Testing Strategy). Every NFR-* traces to an architectural decision + verification method (load test, security test, or monitoring SLO). The FR/NFR identifier scheme is the spine of the traceability matrix.

---

**Definitions of note (4.1.3):** MRN = unique patient ID within a tenant; Tenant = isolated clinic/group account; Branch = physical location; Department = specialty/functional unit within branch; Scope = tenant/branch/department boundary applied to authorisation. SRS aligned in spirit with IEEE 830.

**Cross-references to Part 2 (not in this file):** full CRUD permission matrix, per-module API contracts + data models (field-level specs, schema/types/constraints/indexes), UI specs, Security, DevOps (RPO/RTO detail), Testing Strategy, Development Roadmap, Future Expansion.