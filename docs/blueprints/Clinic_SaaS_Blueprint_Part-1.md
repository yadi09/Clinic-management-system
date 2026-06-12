# Source: Clinic_SaaS_Blueprint_Part-1.docx

Clinic Management SaaS Platform

Implementation-Ready Blueprint

Part 1 of 2 — Executive Summary, Business Analysis, PRD & SRS

| Document | Part 1: Executive Summary · Business Analysis · Product Requirements · Software Requirements |
| --- | --- |
| Product type | Cloud-native, multi-tenant Clinic Management SaaS |
| Target segments | Small, Medium, and Multi-Branch clinics |
| Architecture | Modular monolith, microservice-ready |
| Stack | React/TypeScript/Vite · Go/Gin/SQLC · PostgreSQL · Redis · RabbitMQ · OpenSearch · S3 · Docker/Kubernetes |
| Status | Implementation-ready draft v3 |

# Table of Contents

# 1. Executive Summary

A cloud-native, multi-tenant Clinic Management SaaS platform engineered to onboard a single-doctor practice in minutes and scale to tens of thousands of clinics without re-architecture.

## 1.1 Product Vision

The platform is a commercial, multi-tenant Software-as-a-Service product that digitises the full operational footprint of outpatient clinics: patient registration, appointments, queueing, consultation and electronic medical records, laboratory, pharmacy, inventory, billing, insurance, and analytics. It is delivered as a modular monolith with microservice-ready boundaries, allowing a lean engineering team to ship quickly today while preserving a clean extraction path to independent services as scale demands.

The guiding principle is “start small, scale easily.” A solo practitioner should be able to self-serve onboard, enable only the modules they need, and operate the same product that a 40-branch hospital group runs—the difference being configuration, subscription tier, and enabled feature flags, not a different codebase.

## 1.2 Target Market

The product serves three primary clinic segments, each addressed by the same platform through tiered subscriptions and configurable modules:

| Segment | Profile | Typical Scale | Primary Need |
| --- | --- | --- | --- |
| Small Clinics | Single specialty, owner-operated; 1–3 providers | 1 branch, 3–10 staff, 50–150 visits/day | Fast onboarding, appointments, EMR, simple billing |
| Medium Clinics | Multi-specialty or polyclinic; ancillary services on-site | 1–3 branches, 15–120 staff, 150–600 visits/day | Lab + pharmacy integration, queueing, insurance, reporting |
| Multi-Branch Clinics | Clinic groups / chains with centralised governance | 4–40+ branches, 120–1,500+ staff | Central administration, branch-scoped access, consolidated finance & analytics |

Table 1.1 — Target clinic segments served by a single multi-tenant codebase.

## 1.3 Strategic Objectives

- Time-to-value: a new tenant is operational (registering patients and booking appointments) within 15 minutes of self-service signup.

- Modular monetisation: revenue grows with the customer through tiered plans and per-module feature flags (Pharmacy, Laboratory, Inventory, Insurance, Telemedicine, HR, Finance).

- Operational safety: clinical and financial data are tenant-isolated, auditable, and protected by controls inspired by HIPAA and GDPR principles.

- Scale economics: the architecture supports 100 → 1,000 → 10,000 clinics through staged scaling of PostgreSQL, Redis, RabbitMQ, OpenSearch, and object storage without rewrites.

- Extensibility: an API-first, event-driven core enables future AI features, telemedicine, mobile apps, and national health-system integrations.

## 1.4 Key Differentiators

- Specialty-aware by design. A JSON-schema-driven medical form builder lets each specialty (Dental, Pediatrics, Gynecology, Dermatology, and others) capture its own clinical data without code changes.

- True multi-tenancy with branch scoping. Access control resolves not only by role but by tenant, branch, and department—so a Branch Manager sees only their branch while a Tenant Owner sees the whole organisation.

- Configurable, not custom. Clinics enable/disable entire modules; the same release serves every customer, keeping support and upgrade costs low.

- Microservice-ready monolith. Clear module boundaries and an internal event bus mean the platform ships fast as a monolith yet can extract Laboratory, Pharmacy, or Billing into services under load.

- Standards-based clinical interop. The Laboratory module is built around HL7, FHIR, and ASTM so analyser devices and external labs integrate cleanly.

## 1.5 Technology Approach

The stack is mandated and chosen for performance, type-safety, and operational simplicity at scale:

| Layer | Technology | Rationale |
| --- | --- | --- |
| Frontend | React, TypeScript, Vite, React Router, TanStack Query, TailwindCSS, ShadCN UI, React Hook Form, Zod | Type-safe SPA with fast builds, server-state caching, and accessible component primitives |
| Backend | Go (Gin), SQLC, PostgreSQL, Redis, RabbitMQ | High-throughput compiled services, compile-time-checked SQL, durable relational store, caching, and async messaging |
| Storage | S3-compatible object storage | Scalable, cheap storage for medical documents, lab reports, and images |
| Search | OpenSearch | Full-text patient/record search and analytics indexing |
| Delivery | Docker, Kubernetes, GitHub Actions; Prometheus, Grafana, Loki | Containerised, orchestrated deployment with CI/CD and full observability |

Table 1.2 — Mandated technology stack and selection rationale.

## 1.6 Commercial Model

Revenue is subscription-based across four tiers—Starter, Professional, Business, and Enterprise—differentiated by user, branch, and storage limits and by which modules are unlocked. The model lets a clinic begin on a low-cost Starter plan and expand spend as it adds branches, ancillary services, and advanced analytics. The detailed plan matrix is specified in the Product Requirements Document (Section 3).

## 1.7 Scope of This Document Set

This deliverable is Part 1 of the implementation-ready blueprint and contains four sections: the Executive Summary, the Business Analysis, the Product Requirements Document (PRD), and the Software Requirements Specification (SRS). Subsequent parts cover System Architecture, Database Design, API Specification, UI/UX Specification, Security, DevOps, Testing Strategy, Development Roadmap, and Future Expansion.

| Part 1 Section | Purpose | Primary Audience |
| --- | --- | --- |
| Executive Summary | Vision, market, differentiators, commercial model | Founders, investors, leadership |
| Business Analysis | Stakeholders, operations, pain points, specialty workflows | Product, domain experts, BAs |
| Product Requirements (PRD) | Personas, plans, modules, feature scope, KPIs | Product managers, designers, leads |
| Software Requirements (SRS) | Functional & non-functional requirements, interfaces, acceptance criteria | Engineering, QA, architects |

Table 1.3 — Contents and audience of Part 1.

## 1.8 Success Criteria at a Glance

| Dimension | Target |
| --- | --- |
| Tenant onboarding | < 15 minutes self-service to first patient registered |
| Core API latency | p95 < 300 ms for read endpoints, < 600 ms for writes |
| Availability | 99.9% monthly uptime for the core platform |
| Tenant isolation | Zero cross-tenant data exposure; enforced at query and policy layers |
| Scale path | 100 → 1,000 → 10,000 clinics with no application rewrite |
| Auditability | 100% of clinical and financial mutations recorded in an immutable audit log |

Table 1.4 — Headline success criteria, elaborated as non-functional requirements in Section 4.

# 2. Business Analysis

Who the platform serves, how clinics actually operate today, where the friction lies, and how ten clinical specialties differ in the data and workflows they demand.

## 2.1 Stakeholders

Stakeholders fall into platform-side actors (the SaaS vendor) and tenant-side actors (clinic staff, owners, and patients). Their goals shape both functional scope and access control.

| Stakeholder | Side | Primary Interest | Key Success Measure |
| --- | --- | --- | --- |
| Platform Super Admin | Vendor | Operate the SaaS, manage tenants, ensure uptime | Platform stability, tenant churn |
| SaaS Support Admin | Vendor | Assist tenants, troubleshoot, impersonate with consent | Time-to-resolution, CSAT |
| Tenant Owner | Clinic | Run the clinic business profitably | Revenue, utilisation, compliance |
| Clinic Administrator | Clinic | Configure clinic, staff, schedules, modules | Operational readiness, low admin overhead |
| Branch Manager | Clinic | Run a specific branch day-to-day | Throughput, branch revenue, staff coverage |
| Receptionist / Front Desk | Clinic | Register patients, book, queue, collect payment | Wait time, registration accuracy |
| Doctor / Provider | Clinic | Consult, document, prescribe, order tests | Time-per-consult, record completeness |
| Nurse | Clinic | Vitals, triage, procedures, patient prep | Triage speed, vitals accuracy |
| Lab Technician / Manager | Clinic | Collect samples, run/validate/approve results | Turnaround time, result accuracy |
| Pharmacist / Pharmacy Manager | Clinic | Dispense, manage stock, batches, expiry | Stockouts avoided, dispensing accuracy |
| Cashier / Accountant | Clinic | Billing, payments, refunds, financial reporting | Reconciliation accuracy, revenue capture |
| Inventory / HR Manager | Clinic | Stock and workforce administration | Stock availability, staffing compliance |
| Patient | External | Book, attend, access records, pay | Access, transparency, convenience |
| Insurance Provider / Payer | External | Validate coverage, adjudicate claims | Claim accuracy, settlement time |
| Regulator / Auditor | External | Verify privacy, retention, and audit controls | Compliance evidence on demand |

Table 2.1 — Stakeholder map. Tenant-side roles map directly to the RBAC model (specified in Part 2).

## 2.2 Business Goals

### 2.2.1 Vendor (SaaS) Goals

- Acquire clinics with low-friction self-service onboarding and expand revenue via tier upgrades and module add-ons.

- Keep a single codebase serving all tenants to minimise support and maintenance cost per customer.

- Maintain high availability and provable data isolation to earn trust in a regulated domain.

- Build an extensible core so new modules and AI features can be added without destabilising existing tenants.

### 2.2.2 Clinic (Tenant) Goals

- Reduce patient wait times and front-desk friction.

- Capture complete, legible clinical records and reduce documentation time for providers.

- Eliminate revenue leakage across consultation, lab, pharmacy, and insurance billing.

- Gain visibility into operations across one or many branches through consolidated reporting.

- Manage stock and expiry (pharmacy and consumables) to cut waste and avoid stockouts.

## 2.3 How Clinics Operate Today

Across segments, a clinic visit follows a recognisable arc. The platform's job is to remove handoff friction, capture data once, and surface it everywhere it is needed. The canonical end-to-end flow is:

#### Figure 2.1 — Canonical patient operational flow

| Register →  Appointment →  Queue →  Triage / Vitals →  Consultation →  Orders (Lab/Rx) →  Results →  Diagnosis →  Billing →  Payment →  Pharmacy →  Follow-up |
| --- |

In small clinics several of these steps collapse onto one or two people; in larger clinics each step is a distinct station with its own staff and queue. The same data model serves both.

## 2.4 Current-State Pain Points

| Area | Pain Point Today | Platform Response |
| --- | --- | --- |
| Registration | Duplicate patient records; paper intake; illegible data | Deduplicated patient search; structured intake; unique MRN |
| Appointments | Phone-only booking; no-shows; double-booking | Online booking, reminders, slot/resource locking |
| Queueing | Verbal queue, patients lost or skipped | Digital queue with status and display screens |
| Clinical records | Fragmented paper charts; no history at point of care | Unified EMR with full visit and history timeline |
| Specialty data | Generic forms unfit for dental/peds/derm needs | Specialty form templates via the form builder |
| Lab | Manual result transcription; lost reports; no validation | LIS with device integration, validation, approval |
| Pharmacy | Expiry waste, stockouts, untracked batches | Batch/expiry tracking, reorder alerts, dispensing log |
| Billing | Revenue leakage; services not billed; manual receipts | Service-linked charges, automatic invoicing, receipts |
| Insurance | Manual eligibility checks; slow, error-prone claims | Coverage plans, claim lifecycle, reimbursement tracking |
| Multi-branch | No consolidated view; inconsistent processes | Central administration with branch-scoped operations |
| Compliance | Weak audit trails; unclear data access | Immutable audit log, RBAC, encryption, retention policy |

Table 2.2 — Operational pain points mapped to platform capabilities.

## 2.5 Future Opportunities

The data and event foundation laid in the core unlocks higher-value capabilities once the operational base is adopted:

- Telemedicine and patient mobile apps building on the appointment and EMR modules.

- AI-assisted clinical notes and prescription safety checks over the structured EMR.

- Predictive analytics for no-shows, stock demand, and revenue forecasting.

- PACS / Radiology Information System integration and national health-system connectivity.

- A third-party marketplace for specialty modules and device integrations.

## 2.6 Small Clinic Analysis

### 2.6.1 Typical Staff

Owner-doctor plus 1–2 support staff. One person frequently covers reception, billing, and basic nursing. There is rarely a dedicated lab or pharmacy on-site; tests and dispensing are referred out.

### 2.6.2 Typical Departments

Effectively one: a combined front desk + consultation room. The “department” abstraction still exists in data so the clinic can grow into it later.

### 2.6.3 Typical Workflow

| Walk-in / call →  Register / find patient →  Wait →  Consult + document →  Prescribe →  Collect payment →  Leave |
| --- |

### 2.6.4 Typical Challenges

- No time or staff for complex software; needs near-zero configuration to start.

- Cost-sensitive; must see value on the lowest tier.

- Often mobile/tablet-driven at the desk; UI must work on small screens.

- Data continuity when the practice eventually hires staff or adds a room.

## 2.7 Medium Clinic Analysis

### 2.7.1 Typical Staff

Multiple doctors across specialties, dedicated receptionists, nurses, an on-site lab and/or pharmacy, a cashier, and an administrator. Roles are now distinct people with distinct screens.

### 2.7.2 Typical Departments

Reception, several consultation departments by specialty, Laboratory, Pharmacy, Billing/Cashier, and Administration. Queues and resources are managed per department.

### 2.7.3 Typical Workflow

| Book / arrive →  Reception register →  Department queue →  Nurse vitals →  Doctor consult →  Lab order →  Lab result →  Diagnosis + Rx →  Cashier bill →  Pharmacy dispense →  Follow-up |
| --- |

### 2.7.4 Typical Challenges

- Coordinating handoffs between reception, nursing, doctors, lab, pharmacy, and cashier.

- Preventing revenue leakage when services span multiple stations.

- Managing insurance eligibility and claims for a meaningful share of patients.

- Reporting that reconciles clinical activity with finance and stock.

## 2.8 Multi-Branch Clinic Analysis

### 2.8.1 Typical Structure

A tenant owns multiple branches under one organisation. Governance (staff policies, catalogues, price lists, form templates) is set centrally and inherited by branches, with branch-level overrides where allowed.

### 2.8.2 Operational Model

- Central administration defines shared catalogues (services, drugs, lab tests) and price lists.

- Branch Managers run day-to-day operations scoped to their branch only.

- Inventory transfers move stock between a central store and branches.

- Patients may be shared across branches (one MRN per tenant) so records follow the patient.

- Finance consolidates revenue across branches while preserving per-branch P&L.

### 2.8.3 Typical Challenges

- Enforcing branch-scoped access so staff see only their branch's operational data.

- Consistent processes and catalogues without removing local flexibility.

- Consolidated analytics across branches with drill-down to a single branch.

- Stock balancing and inter-branch transfers.

## 2.9 Clinic Specialty Analysis

Although the operational arc is shared, specialties differ sharply in the clinical data they capture, the forms they need, and the ancillary steps in a visit. The platform expresses these differences through configurable form templates, specialty-specific EMR sections, and module enablement—never through forked code. The table below summarises ten specialties; detailed notes follow.

| Specialty | Distinctive Workflow Element | Key Clinical Data / Forms | Notable Module Needs |
| --- | --- | --- | --- |
| General Medicine | Broad triage; common acute & chronic care | Chief complaint, vitals, SOAP, basic labs | Lab, Pharmacy, Billing |
| Internal Medicine | Chronic disease management, longitudinal follow-up | Problem list, med reconciliation, trend charts | Lab (panels), trending analytics |
| Pediatrics | Growth & immunisation tracking; weight-based dosing | Growth charts, vaccination schedule, age-aware vitals | Vaccination registry, weight-based Rx checks |
| Gynecology | Reproductive & antenatal care; sensitive data | Menstrual/obstetric history, antenatal forms, EDD | Heightened privacy controls, scheduling cycles |
| Dermatology | Visual diagnosis; lesion tracking over time | Body-map annotations, lesion photos, biopsy orders | Image storage, photo comparison, Lab (histopath) |
| Dental | Tooth-level charting; procedure-heavy | Odontogram, periodontal chart, treatment plan | Procedure catalogue, per-tooth billing, imaging |
| ENT | Endoscopic exams; audiology | Ear/nose/throat exam fields, audiogram | Procedure notes, device/image attachments |
| Orthopedics | Imaging-driven; fracture & post-op follow-up | ROM/strength exam, imaging refs, fracture notes | PACS/imaging refs, procedure & follow-up tracking |
| Cardiology | Diagnostics-heavy; risk stratification | ECG/echo results, BP trends, risk scores | Device/result integration, trend analytics |
| Ophthalmology | Per-eye measurements; optical prescriptions | Visual acuity, IOP, refraction (OD/OS), fundus | Per-eye fields, optical Rx, imaging |

Table 2.3 — Specialty comparison: each row drives a default form template and EMR configuration.

### 2.9.1 General Medicine

Patient workflow. Mixed walk-in and booked patients; broad presenting complaints; triage routes urgent cases first.

Consultation workflow. History and exam recorded as SOAP notes; common point-of-care tests; prescriptions and referrals as needed.

Medical forms. General intake, vitals, SOAP note, referral, and prescription forms—the default template set.

Clinical records. Episodic visits with a running problem list and medication history.

Additional requirements. Acts as the baseline configuration other specialties extend; Lab and Pharmacy commonly enabled.

### 2.9.2 Internal Medicine

Patient workflow. Predominantly booked follow-ups for chronic conditions (diabetes, hypertension, etc.).

Consultation workflow. Emphasis on longitudinal review: trend interpretation, medication reconciliation, and care-plan updates.

Medical forms. Problem-oriented forms, medication reconciliation form, chronic-care follow-up template.

Clinical records. Strong reliance on historical trends—lab panels and vitals charted over time.

Additional requirements. Trend analytics and recall scheduling for periodic monitoring are high value.

### 2.9.3 Pediatrics

Patient workflow. Parent/guardian accompanies a minor; appointments tied to immunisation milestones.

Consultation workflow. Age- and weight-aware assessment; growth plotting; vaccination administration and counselling.

Medical forms. Growth-chart capture, immunisation record, age-banded vitals, weight-based dosing aids.

Clinical records. Continuous growth and vaccination history are first-class; guardian linkage is required.

Additional requirements. Vaccination registry, weight-based prescription safety checks, and guardian consent handling.

### 2.9.4 Gynecology

Patient workflow. Booked and sensitive visits; antenatal patients follow a scheduled cadence.

Consultation workflow. Reproductive and obstetric history; antenatal assessments; cycle- and pregnancy-aware planning.

Medical forms. Menstrual/obstetric history, antenatal visit form, estimated-due-date calculator fields.

Clinical records. Longitudinal reproductive and pregnancy records with strict confidentiality.

Additional requirements. Elevated privacy controls and consent; specialised recurring scheduling for antenatal care.

### 2.9.5 Dermatology

Patient workflow. Visual, often photo-documented complaints; review visits to track lesion change.

Consultation workflow. Inspection-led diagnosis with body-map localisation and serial photography; biopsy ordering.

Medical forms. Body-map annotation, lesion description fields, photo-attachment capture, biopsy request.

Clinical records. Image-rich records with before/after comparison and histopathology results.

Additional requirements. Robust image storage, photo comparison UI, and Lab integration for histopathology.

### 2.9.6 Dental

Patient workflow. Procedure-oriented visits; treatment plans span multiple appointments.

Consultation workflow. Tooth-level charting (odontogram), periodontal assessment, staged treatment planning, procedures.

Medical forms. Odontogram, periodontal chart, treatment-plan builder, per-procedure consent.

Clinical records. Per-tooth status history and a cumulative treatment plan with completed/planned procedures.

Additional requirements. Procedure catalogue, per-tooth and per-procedure billing, and dental imaging attachments.

### 2.9.7 ENT (Otorhinolaryngology)

Patient workflow. Mixed acute and chronic; some visits include endoscopic or audiometric procedures.

Consultation workflow. Focused ear/nose/throat examination with optional endoscopy and audiology testing.

Medical forms. ENT structured exam form, audiogram capture, endoscopy procedure note.

Clinical records. Procedure notes and device/image attachments alongside standard EMR.

Additional requirements. Procedure documentation and attachment of audiograms and endoscopic media.

### 2.9.8 Orthopedics

Patient workflow. Imaging-driven referrals; fracture care and post-operative follow-up series.

Consultation workflow. Musculoskeletal exam (range of motion, strength), imaging review, procedure and cast/follow-up planning.

Medical forms. MSK exam form, imaging reference fields, fracture/post-op follow-up template.

Clinical records. Imaging references, procedure history, and scheduled post-op follow-up tracking.

Additional requirements. PACS/imaging reference integration and structured follow-up scheduling.

### 2.9.9 Cardiology

Patient workflow. Booked diagnostic and follow-up visits; risk-based monitoring cadence.

Consultation workflow. Diagnostics-centred: ECG/echo interpretation, blood-pressure trends, cardiovascular risk scoring.

Medical forms. Cardiac assessment form, ECG/echo result capture, risk-score fields.

Clinical records. Trend-heavy records linking diagnostics, vitals, and medication over time.

Additional requirements. Diagnostic device/result integration and longitudinal trend analytics.

### 2.9.10 Ophthalmology

Patient workflow. Booked visits with technician-collected measurements before the physician exam.

Consultation workflow. Per-eye assessment: visual acuity, intraocular pressure, refraction, fundus examination.

Medical forms. Per-eye (OD/OS) structured fields, refraction/optical-prescription form, imaging capture.

Clinical records. Paired per-eye measurement history and optical prescriptions over time.

Additional requirements. Per-eye data modelling, optical prescription generation, and ophthalmic imaging storage.

Design implication. Every specialty above is realised through (a) a default form-template set selected at clinic/department setup, (b) optional EMR sections (e.g., odontogram, growth chart, per-eye fields), and (c) module enablement (Lab, Pharmacy, imaging). No specialty requires a code fork—this is the central architectural commitment validated in the SRS.

# 3. Product Requirements Document (PRD)

What the product must do, for whom, under which subscription, and how success is measured—expressed as personas, plans, a module catalogue, and prioritised feature scope.

## 3.1 Product Overview

The product is a configurable, multi-tenant clinic management platform. A tenant (a clinic or clinic group) subscribes to a plan, optionally enables modules, configures one or more branches and departments, invites staff with scoped roles, and operates the full patient journey from registration to follow-up. The same product instance serves all tenants; behaviour is determined by subscription tier, enabled feature flags, and per-tenant configuration.

### 3.1.1 Product Goals (Prioritised)

- Deliver a friction-free core (registration, appointments, queue, consultation/EMR, basic billing) that a small clinic can run on day one.

- Layer ancillary modules (Lab, Pharmacy, Inventory, Insurance) that medium and multi-branch clinics enable as they grow.

- Provide central administration and branch-scoped operations for multi-branch tenants.

- Guarantee tenant isolation, auditability, and privacy controls appropriate to healthcare data.

- Expose an API-first, event-driven core ready for telemedicine, AI, and external integrations.

## 3.2 User Personas

| Persona | Context | Goals | Frustrations the Product Removes |
| --- | --- | --- | --- |
| Dr. Owner (solo) | Runs a 1-doctor clinic; tech-light; uses a tablet | Start fast, see patients, get paid | Setup complexity; paper charts; manual receipts |
| Clinic Admin (medium) | Configures a 3-doctor polyclinic | Set up staff, schedules, catalogues, modules | Disconnected tools; inconsistent processes |
| Front-Desk Rana | Registers and queues 200 patients/day | Fast register, book, queue, collect | Duplicate records; lost queue; long waits |
| Dr. Provider | Consults across a busy day | Document fast, see history, order & prescribe | Illegible/missing history; slow notes |
| Nurse Maya | Triage and vitals station | Capture vitals, prep patients, run procedures | Re-keying data; unclear queue |
| Lab Tech Sam | On-site laboratory | Collect, run, validate, approve, report | Manual transcription; lost results |
| Pharmacist Omar | On-site pharmacy | Dispense, manage batches & expiry | Stockouts; expired stock; manual logs |
| Accountant Lina | Finance for a clinic group | Reconcile revenue, refunds, reports | Revenue leakage; manual consolidation |
| Branch Manager Ken | Runs one of many branches | Run branch, see only branch data | No branch-scoped visibility/control |
| Tenant Owner (group) | Owns a multi-branch chain | Govern centrally, see consolidated KPIs | No cross-branch view; policy drift |
| Patient Portal User | Books and reviews own records | Self-book, view results, pay | Phone-only booking; opaque records |

Table 3.1 — Personas drive role design and screen priorities.

## 3.3 Subscription Plans & Limits

Four tiers gate capacity (users, branches, storage) and module access. Limits are enforced at the tenant level; exceeding a limit blocks the action with an upgrade prompt rather than silently failing.

| Capability / Limit | Starter | Professional | Business | Enterprise |
| --- | --- | --- | --- | --- |
| Branches | 1 | Up to 3 | Up to 10 | Unlimited (fair-use) |
| Active staff users | Up to 5 | Up to 25 | Up to 100 | Unlimited (fair-use) |
| Object storage | 5 GB | 50 GB | 500 GB | Custom |
| Patient records | Unlimited | Unlimited | Unlimited | Unlimited |
| Core (Auth, Patients, Appointments, Queue, Consultation/EMR, Billing) | Included | Included | Included | Included |
| Laboratory module | — | Optional | Included | Included |
| Pharmacy module | — | Optional | Included | Included |
| Inventory module | — | Optional | Included | Included |
| Insurance module | — | — | Optional | Included |
| Telemedicine | — | — | Optional | Optional |
| HR module | — | — | Optional | Included |
| Finance (advanced) | Basic | Basic | Included | Included |
| Reporting & Analytics | Basic | Standard | Advanced | Advanced + custom |
| Audit log retention | 90 days | 1 year | 3 years | Configurable |
| API access | — | Read-only | Full | Full + higher rate limits |
| MFA enforcement | Optional | Optional | Enforced option | Enforced |
| Support | Community | Email | Priority | Dedicated / SLA |

Table 3.2 — Subscription matrix. “Optional” = available as a paid add-on feature flag on that tier.

Note on limits. Limits are configuration, not code: plan definitions live in data so commercial tuning (e.g., raising Professional to 5 branches) requires no deployment. Storage and user counts are checked on the relevant create/activate operations.

## 3.4 Feature Flags

Each optional capability is a feature flag resolved per tenant (and where relevant per branch). The frontend hides disabled modules from navigation; the backend rejects calls to disabled-module endpoints with a clear, recoverable error. Flags are evaluated from: plan defaults → tenant add-ons → explicit admin overrides.

| Flag | Controls | Default by Plan |
| --- | --- | --- |
| pharmacy | Pharmacy module & dispensing | Off ≤ Pro (optional), On ≥ Business |
| laboratory | LIS module | Off ≤ Pro (optional), On ≥ Business |
| inventory | Inventory & transfers | Off ≤ Pro (optional), On ≥ Business |
| insurance | Insurance & claims | Off ≤ Business (optional), On Enterprise |
| telemedicine | Video consultation | Off (optional on Business+) |
| hr | HR module | Off (optional on Business), On Enterprise |
| finance_advanced | Advanced finance & reporting | On ≥ Business |

Table 3.3 — Feature flags and plan defaults.

## 3.5 Module Catalogue

Thirty-one modules compose the platform. Each is specified in full (entities, APIs, UI, permissions) in Part 2; the catalogue below fixes scope, ownership, and tier availability for Part 1.

| # | Module | Purpose (one line) | Tier |
| --- | --- | --- | --- |
| 1 | Authentication | Login, tokens, MFA, sessions | Core |
| 2 | User Management | Staff accounts, invitations, lifecycle | Core |
| 3 | Role Management | Roles, permissions, scope assignment | Core |
| 4 | Tenant Management | Tenant lifecycle, plans, billing of subscription | Platform |
| 5 | Clinic Management | Clinic profile, settings, module enablement | Core |
| 6 | Branch Management | Branches under a tenant, branch settings | Core |
| 7 | Department Management | Departments/specialties within branches | Core |
| 8 | Patient Registration | Create/maintain patient records & MRN | Core |
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
| 20 | Laboratory (LIS) | Tests, samples, results, approval | laboratory |
| 21 | Pharmacy | Drug catalogue, dispensing, batches | pharmacy |
| 22 | Inventory | Stock, transfers, purchasing | inventory |
| 23 | Billing | Charge capture across services | Core |
| 24 | Invoicing | Invoice generation & lifecycle | Core |
| 25 | Payments | Payment capture, refunds, receipts | Core |
| 26 | Insurance | Providers, plans, claims, reimbursement | insurance |
| 27 | Notifications | Email/SMS/in-app/push delivery | Core |
| 28 | Reporting | Operational & financial reports | Core/Advanced |
| 29 | Analytics | Dashboards & KPIs | Core/Advanced |
| 30 | Audit Logs | Immutable change & access logging | Core |
| 31 | Settings | Tenant/branch/user configuration | Core |

Table 3.4 — Module catalogue. “Core” ships on all tiers; lowercase names denote the gating feature flag; “Platform” is vendor-only.

## 3.6 Tenant Lifecycle

A tenant moves through a defined lifecycle. State transitions are auditable and drive access:

#### Figure 3.1 — Tenant lifecycle

| Created →  Onboarding →  Active →  Suspended →  Cancelled |
| --- |

| State | Meaning | Access | Trigger to Next |
| --- | --- | --- | --- |
| Created | Tenant exists; signup begun | Owner can complete onboarding | Onboarding wizard started |
| Onboarding | Configuring clinic, branch, staff | Limited; setup screens only | Onboarding completed & plan confirmed |
| Active | Operating normally | Full per plan & flags | Payment failure / admin action |
| Suspended | Temporarily disabled (e.g., billing) | Read-only or blocked; data retained | Payment resolved → Active; or → Cancelled |
| Cancelled | Subscription ended | Blocked; data retained per policy then purged | Reactivation (new cycle) or purge |

Table 3.5 — Tenant lifecycle states and transitions.

## 3.7 Access Control Overview

Authorisation resolves on three axes: role (what actions), scope (tenant → branch → department), and module enablement (is the feature flag on). The full CRUD permission matrix is specified in Part 2; the PRD fixes the role inventory and scoping rules below.

### 3.7.1 Roles

Platform Super Admin, SaaS Support Admin, Tenant Owner, Clinic Administrator, Branch Manager, Receptionist, Doctor, Nurse, Laboratory Technician, Laboratory Manager, Pharmacist, Pharmacy Manager, Cashier, Accountant, Inventory Manager, HR Manager, and Patient Portal User.

### 3.7.2 Scoping Rules

- Platform roles operate above tenants (vendor side) and never appear inside tenant data views.

- Tenant Owner and Clinic Administrator are tenant-wide; they see all branches and departments.

- Branch Manager and operational roles are branch-scoped; they see only assigned branch(es).

- Clinical roles may be further department-scoped (e.g., a doctor restricted to their specialty department).

- Patient Portal User sees only their own (or dependents') records.

- Every authorisation check is also gated by the relevant module feature flag.

## 3.8 Representative User Stories

Stories are written as “As a <role>, I want <capability> so that <value>” with acceptance hints. A complete backlog accompanies each module spec in Part 2; the set below anchors scope.

| ID | User Story | Acceptance Hint |
| --- | --- | --- |
| US-01 | As a clinic owner, I want to self-onboard and book a first patient within minutes so I can start operating immediately. | Onboarding wizard completes; first appointment created |
| US-02 | As a receptionist, I want to search by phone/MRN/national ID and be warned of likely duplicates so I avoid double records. | Fuzzy match surfaces existing patients before create |
| US-03 | As a receptionist, I want to add a patient to a department queue so the doctor sees who is waiting. | Queue entry visible to department in real time |
| US-04 | As a doctor, I want the patient's full history and current vitals on one screen so I can decide quickly. | Encounter view shows timeline, vitals, allergies |
| US-05 | As a doctor, I want to write a SOAP note using a specialty template so documentation matches my field. | Template selected by department; saved to EMR |
| US-06 | As a doctor, I want prescription safety checks (allergy, weight-based for peds) so I prescribe safely. | Warnings shown on conflicting allergy/dose |
| US-07 | As a lab tech, I want to enter and validate results, then route for approval so reports are trustworthy. | Result states: entered → validated → approved |
| US-08 | As a pharmacist, I want batch and expiry tracking so I never dispense expired stock. | Dispense blocks expired/insufficient batches |
| US-09 | As a cashier, I want all services on a visit auto-collected into one invoice so nothing is missed. | Consult+lab+pharmacy charges aggregate to invoice |
| US-10 | As an accountant, I want consolidated revenue across branches with drill-down so I can report accurately. | Group total reconciles to per-branch detail |
| US-11 | As a branch manager, I want to see only my branch's operations so my dashboards stay relevant. | Data scoped to assigned branch(es) |
| US-12 | As a tenant owner, I want to enable/disable modules so I pay only for what I use. | Flag toggles hide/show module immediately |
| US-13 | As a patient, I want to book online and view my results so I avoid phone tag. | Portal booking + result visibility after approval |
| US-14 | As a compliance officer, I want an immutable audit trail of who accessed/changed records. | Every clinical/financial mutation logged |
| US-15 | As an admin, I want to build a custom intake form without code so I capture specialty data. | Drag-and-drop form saved, versioned, assignable |

Table 3.6 — Anchor user stories spanning the core journey and key roles.

## 3.9 Success Metrics & KPIs

| Category | KPI | Target |
| --- | --- | --- |
| Adoption | Time to first patient registered (new tenant) | < 15 minutes |
| Adoption | Trial-to-paid conversion | ≥ 25% |
| Engagement | Weekly active staff users / licensed users | ≥ 70% |
| Operations | Average front-desk registration time | < 90 seconds |
| Operations | Average patient wait (queue) reduction vs. baseline | ≥ 20% |
| Clinical | Encounters with complete documentation | ≥ 95% |
| Lab | Result turnaround (collection → approved) | Tracked; improving trend |
| Pharmacy | Expired-stock write-off rate | Declining month-over-month |
| Finance | Billed-vs-rendered service capture | ≥ 99% |
| Reliability | Core platform availability | ≥ 99.9% monthly |
| Retention | Net revenue retention | ≥ 110% |

Table 3.7 — Product and business KPIs.

## 3.10 Assumptions, Constraints & Dependencies

### 3.10.1 Assumptions

- Clinics have reliable internet during operating hours; brief offline tolerance is desirable but not a launch requirement.

- Tenants accept a shared, configurable codebase rather than bespoke per-clinic builds.

- Clinical coding uses ICD for diagnoses; drug and lab catalogues are seeded and tenant-extendable.

### 3.10.2 Constraints

- Mandated stack (React/TS/Vite frontend; Go/Gin/SQLC/PostgreSQL/Redis/RabbitMQ backend; OpenSearch; S3-compatible storage; Docker/Kubernetes).

- Modular monolith now, microservice-ready boundaries for later extraction.

- Privacy controls inspired by HIPAA and GDPR principles; the product is not a substitute for a tenant's own legal compliance program.

### 3.10.3 Dependencies

- Email/SMS providers for notifications; payment gateway(s) for online payments.

- S3-compatible object storage and OpenSearch as managed or self-hosted infrastructure.

- Optional lab analyser devices supporting HL7/ASTM for device integration.

## 3.11 Out of Scope (Part 1 / MVP)

- Full hospital inpatient/ward management and operating-theatre scheduling.

- Native mobile apps (planned as future expansion; responsive web at launch).

- AI clinical notes, AI prescription assistance, and predictive analytics (future).

- PACS/RIS and national health-system integrations (future expansion).

- Third-party marketplace (future expansion).

## 3.12 Release Phasing (Summary)

Detailed roadmap, timelines, and risks are in Part 2. The phase intent:

| Phase | Theme | Headline Scope |
| --- | --- | --- |
| 1 | MVP | Auth, tenants, patients, appointments, queue, consultation/EMR, basic billing |
| 2 | Operational Clinic | Lab, Pharmacy, Inventory, full billing/payments, notifications, reporting |
| 3 | Multi-Branch | Branch scoping, transfers, consolidated finance & analytics, insurance |
| 4 | Advanced SaaS | Form builder maturity, advanced analytics, API platform, telemedicine option |
| 5 | Enterprise Expansion | AI features, mobile, PACS/RIS, national integrations, marketplace |

Table 3.8 — Release phasing summary.

# 4. Software Requirements Specification (SRS)

The contract between product and engineering: numbered functional requirements per module, external interfaces, and the non-functional bar the platform must clear. Aligned in spirit with IEEE 830.

## 4.1 Introduction

### 4.1.1 Purpose

This SRS specifies the functional and non-functional requirements of the Clinic Management SaaS platform in sufficient detail for engineering, QA, and architecture to design and build the system. Requirements are uniquely identified (FR-<MODULE>-<n> for functional, NFR-<n> for non-functional) for traceability to tests.

### 4.1.2 Scope

The SRS covers the platform's server-side services, web client, data, interfaces, and quality attributes for the modules enumerated in Section 3.5. It defines what the system must do, not how it is implemented; architecture and database design are specified in Part 2.

### 4.1.3 Definitions & Acronyms

| Term | Definition |
| --- | --- |
| Tenant | An isolated clinic or clinic group account on the platform |
| Branch | A physical location belonging to a tenant |
| Department | A specialty/functional unit within a branch |
| MRN | Medical Record Number; unique patient identifier within a tenant |
| EMR | Electronic Medical Record |
| LIS | Laboratory Information System |
| RBAC | Role-Based Access Control |
| Feature flag | A toggle enabling/disabling a module per tenant/branch |
| SOAP | Subjective, Objective, Assessment, Plan clinical note structure |
| HL7 / FHIR / ASTM | Healthcare interoperability standards used by the LIS |
| Scope | The tenant/branch/department boundary applied to authorisation |
| MFA | Multi-Factor Authentication |

### 4.1.4 Requirement Priority Legend

MUST = mandatory for the phase that introduces it; SHOULD = strongly desired; MAY = optional/nice-to-have. Phase mapping is given in the PRD release summary (Table 3.8).

## 4.2 Overall Description

### 4.2.1 Product Perspective

The system is a new, self-contained multi-tenant SaaS delivered as a modular monolith with microservice-ready internal boundaries. It exposes a REST API consumed by a React single-page application and by external integrators. Asynchronous work (notifications, indexing, report generation) flows through a message broker.

#### Figure 4.1 — System context

| Web SPA / API Clients →  API Gateway / Gin Services →  PostgreSQL + Redis →  RabbitMQ Workers →  OpenSearch + Object Storage |
| --- |

### 4.2.2 User Classes

User classes correspond to the seventeen roles in Section 3.7.1, partitioned into platform (vendor) users, tenant staff users (tenant-, branch-, and department-scoped), and external users (patients, integrators).

### 4.2.3 Operating Environment

- Server: Linux containers orchestrated by Kubernetes; Go services; PostgreSQL, Redis, RabbitMQ, OpenSearch; S3-compatible object storage.

- Client: modern evergreen browsers (Chrome, Edge, Firefox, Safari) on desktop, tablet, and mobile viewports.

- Network: HTTPS only; all inter-service and client traffic encrypted in transit.

### 4.2.4 Design & Implementation Constraints

- Mandated stack and modular-monolith architecture (see PRD 3.10.2).

- Tenant data isolation must be enforced at the query/policy layer on every data access.

- All SQL is authored through SQLC (compile-time-checked queries).

- Privacy controls inspired by HIPAA and GDPR principles.

## 4.3 Functional Requirements

Functional requirements are grouped by module. Every requirement is testable; acceptance-criteria patterns are given in Section 4.6. Module-level API contracts and data models follow in Part 2.

### 4.3.1 Authentication (FR-AUTH)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-AUTH-01 | The system MUST authenticate users via email/username and password and issue a short-lived access token plus a refresh token. | MUST |
| FR-AUTH-02 | The system MUST support refresh-token rotation and revoke the prior refresh token on each rotation. | MUST |
| FR-AUTH-03 | The system MUST support optional MFA (TOTP) per user and MUST allow tenants to enforce MFA for all staff. | MUST |
| FR-AUTH-04 | The system MUST lock an account after a configurable number of failed attempts and log the event. | MUST |
| FR-AUTH-05 | The system MUST support password reset via a time-limited, single-use token delivered by email. | MUST |
| FR-AUTH-06 | The system MUST invalidate all active sessions on password change and on explicit logout-all. | MUST |
| FR-AUTH-07 | The system SHOULD allow SaaS Support Admin to impersonate a tenant user only with recorded, consented authorisation, fully audited. | SHOULD |

### 4.3.2 User, Role & Tenant Management (FR-USR / FR-ROLE / FR-TEN)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-USR-01 | The system MUST allow administrators to invite staff by email; invited users complete signup via a time-limited link. | MUST |
| FR-USR-02 | The system MUST support user lifecycle states: invited, active, suspended, deactivated. | MUST |
| FR-USR-03 | The system MUST enforce the plan's active-user limit and block activation beyond it with an upgrade prompt. | MUST |
| FR-ROLE-01 | The system MUST provide the seventeen predefined roles and MUST allow assignment of role plus scope (branch/department) to a user. | MUST |
| FR-ROLE-02 | The system SHOULD allow administrators to define custom roles by composing permissions (Business+). | SHOULD |
| FR-TEN-01 | The system MUST support tenant lifecycle states (Created, Onboarding, Active, Suspended, Cancelled) with audited transitions. | MUST |
| FR-TEN-02 | The system MUST enforce subscription limits (branches, users, storage) per the active plan. | MUST |
| FR-TEN-03 | The system MUST evaluate feature flags from plan defaults, add-ons, and overrides, and reject calls to disabled modules with a recoverable error. | MUST |
| FR-TEN-04 | The system MUST retain tenant data on suspension and apply the configured retention policy on cancellation before purge. | MUST |

### 4.3.3 Clinic, Branch & Department Management (FR-CLN / FR-BR / FR-DEP)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-CLN-01 | The system MUST let a tenant configure clinic profile, locale, time zone, and enabled modules. | MUST |
| FR-BR-01 | The system MUST support multiple branches per tenant within plan limits, each with its own address, hours, and resources. | MUST |
| FR-BR-02 | The system MUST allow shared catalogues (services, drugs, tests, forms) defined centrally with optional branch overrides. | MUST |
| FR-DEP-01 | The system MUST support departments within a branch, each linked to a specialty and a default form-template set. | MUST |
| FR-DEP-02 | The system MUST allow assignment of providers and resources (rooms) to departments for scheduling and queueing. | MUST |

### 4.3.4 Patient Registration & Search (FR-PAT)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-PAT-01 | The system MUST create a patient record capturing identity, demographics, contact, emergency contact, and insurance details (field-level spec in Part 2). | MUST |
| FR-PAT-02 | The system MUST assign a unique MRN per patient within a tenant and prevent duplicate MRNs. | MUST |
| FR-PAT-03 | The system MUST detect likely duplicates on create using name, date of birth, phone, and national ID, and warn the operator before saving. | MUST |
| FR-PAT-04 | The system MUST provide fast search by name, MRN, phone, national ID, or passport, returning results scoped to the tenant. | MUST |
| FR-PAT-05 | The system MUST support guardian/dependent linkage for minors and shared accounts. | MUST |
| FR-PAT-06 | The system MUST store clinical summary data (allergies, chronic conditions, family history, vaccination history) and surface allergies prominently at point of care. | MUST |
| FR-PAT-07 | The system MUST allow attachment of documents (PDF, images, reports, scans) to a patient with type and date metadata. | MUST |
| FR-PAT-08 | The system MUST share patient identity across a tenant's branches (one MRN per tenant) while scoping operational visibility by role. | MUST |

### 4.3.5 Appointments & Queue (FR-APT / FR-QUE)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-APT-01 | The system MUST allow booking appointments against a provider/department/resource slot, preventing double-booking of the same resource. | MUST |
| FR-APT-02 | The system MUST support reschedule and cancel with reason capture and full history. | MUST |
| FR-APT-03 | The system MUST send configurable reminders (email/SMS) ahead of appointments. | SHOULD |
| FR-APT-04 | The system SHOULD support online self-booking via the patient portal constrained to published availability. | SHOULD |
| FR-QUE-01 | The system MUST maintain a live queue per department/branch with states (waiting, called, in-consult, done, no-show). | MUST |
| FR-QUE-02 | The system MUST update queue state in near-real-time for relevant staff and optional display screens. | MUST |
| FR-QUE-03 | The system SHOULD support priority/triage ordering overriding arrival order with an audit reason. | SHOULD |

### 4.3.6 Consultation & EMR (FR-CON / FR-EMR)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-CON-01 | The system MUST create an encounter when a patient enters consultation, linking the visit to provider, department, and queue entry. | MUST |
| FR-CON-02 | The encounter view MUST present history timeline, active problems, allergies, current medications, and latest vitals on one screen. | MUST |
| FR-EMR-01 | The system MUST capture SOAP and progress notes, persisted to the EMR and immutable once signed (amendments tracked). | MUST |
| FR-EMR-02 | The system MUST record diagnoses with ICD codes, procedures, referrals, and follow-up instructions on an encounter. | MUST |
| FR-EMR-03 | The system MUST capture vitals with units and timestamps and chart trends over time. | MUST |
| FR-EMR-04 | The system MUST render specialty-specific EMR sections (e.g., odontogram, growth chart, per-eye fields) based on the department's configuration. | MUST |
| FR-EMR-05 | The system MUST link orders (lab tests, prescriptions) and their results back to the originating encounter. | MUST |
| FR-EMR-06 | The EMR MUST present a complete, chronological medical history across all of the patient's encounters within the tenant. | MUST |

### 4.3.7 Prescriptions (FR-RX)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-RX-01 | The system MUST allow a provider to create a prescription with drug, dose, route, frequency, duration, and instructions from the drug catalogue. | MUST |
| FR-RX-02 | The system MUST check prescriptions against recorded patient allergies and surface warnings before signing. | MUST |
| FR-RX-03 | The system SHOULD support weight-based dosing aids for pediatric patients and flag out-of-range doses. | SHOULD |
| FR-RX-04 | A signed prescription MUST be available to the Pharmacy module for dispensing when enabled, otherwise printable/exportable. | MUST |

### 4.3.8 Medical Form Builder (FR-FRM)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-FRM-01 | The system MUST provide a drag-and-drop form builder producing a versioned JSON schema. | MUST |
| FR-FRM-02 | The builder MUST support field types: text, text area, number, date, time, checkbox, radio, dropdown, multi-select, file upload, and signature. | MUST |
| FR-FRM-03 | The system MUST support conditional fields, validation rules, templates, and form cloning. | MUST |
| FR-FRM-04 | The system MUST version forms so existing records retain the schema version under which they were captured. | MUST |
| FR-FRM-05 | The system MUST allow role/department restrictions on who can complete a given form. | MUST |
| FR-FRM-06 | The system MUST ship default templates for at least General Medicine, Pediatrics, Gynecology, Dental, and Dermatology. | MUST |

### 4.3.9 Laboratory / LIS (FR-LAB)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-LAB-01 | The system MUST maintain a test catalogue with test groups, specimen types, units, and reference ranges. | MUST |
| FR-LAB-02 | The system MUST capture lab orders from an encounter and generate sample collection records with tracking identifiers. | MUST |
| FR-LAB-03 | The system MUST support sample status tracking (ordered, collected, received, in-process, resulted). | MUST |
| FR-LAB-04 | The system MUST support result entry via manual entry, CSV import, and device integration. | MUST |
| FR-LAB-05 | The system MUST enforce a result lifecycle: entered → validated → approved, with role-gated transitions. | MUST |
| FR-LAB-06 | The system MUST generate result reports and make approved results available to the ordering provider and (when permitted) the patient portal. | MUST |
| FR-LAB-07 | The system SHOULD support HL7, FHIR, and ASTM interfaces for device and external-lab integration. | SHOULD |

### 4.3.10 Pharmacy (FR-PHA)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-PHA-01 | The system MUST maintain a drug catalogue with classification, form, strength, and units. | MUST |
| FR-PHA-02 | The system MUST track stock by batch with expiry dates and prevent dispensing of expired or insufficient stock. | MUST |
| FR-PHA-03 | The system MUST support dispensing against a prescription and over-the-counter (OTC) sales. | MUST |
| FR-PHA-04 | The system MUST support suppliers, purchase orders, goods receiving, and returns. | MUST |
| FR-PHA-05 | The system MUST raise low-stock and near-expiry alerts based on configurable thresholds. | SHOULD |
| FR-PHA-06 | Dispensing MUST create billable charges linked to the patient's visit when applicable. | MUST |

### 4.3.11 Inventory (FR-INV)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-INV-01 | The system MUST track stock at central and branch levels with on-hand quantities and valuation. | MUST |
| FR-INV-02 | The system MUST support inter-branch transfers with dispatch and receipt confirmation. | MUST |
| FR-INV-03 | The system MUST support purchase requests, purchase orders, and goods receiving. | MUST |
| FR-INV-04 | The system MUST support stock counts and audits with variance reporting. | MUST |

### 4.3.12 Billing, Invoicing & Payments (FR-BIL / FR-INVC / FR-PAY)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-BIL-01 | The system MUST aggregate charges from consultation, laboratory, pharmacy, and procedures into a patient's visit bill. | MUST |
| FR-BIL-02 | The system MUST support package billing, discounts (with authorisation), and price lists per branch. | MUST |
| FR-INVC-01 | The system MUST generate invoices with line items, taxes, and totals, and maintain invoice lifecycle (draft, issued, paid, void). | MUST |
| FR-PAY-01 | The system MUST capture payments (cash, card, and gateway where configured), partial payments, and produce receipts. | MUST |
| FR-PAY-02 | The system MUST support refunds with reason capture and audit. | MUST |
| FR-PAY-03 | The system MUST reconcile payments to invoices and expose daily cash-up/closure reporting. | MUST |

### 4.3.13 Insurance (FR-INS)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-INS-01 | The system MUST maintain insurance providers and coverage plans with covered services and co-pay rules. | MUST |
| FR-INS-02 | The system MUST record patient insurance and apply coverage to eligible charges at billing time. | MUST |
| FR-INS-03 | The system MUST manage a claim lifecycle: prepared → submitted → approved/rejected → reimbursed, with status history. | MUST |
| FR-INS-04 | The system SHOULD support reimbursement tracking and reconciliation against submitted claims. | SHOULD |

### 4.3.14 Notifications, Reporting, Analytics, Audit & Settings (FR-NOT / FR-REP / FR-ANL / FR-AUD / FR-SET)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-NOT-01 | The system MUST deliver notifications via email, SMS, and in-app channels, with push as an extension point. | MUST |
| FR-NOT-02 | Notification sending MUST be asynchronous via the message broker with retry and failure logging. | MUST |
| FR-REP-01 | The system MUST provide role-appropriate operational and financial reports with filters, and export to CSV/PDF. | MUST |
| FR-ANL-01 | The system MUST provide dashboards per role (reception, doctor, nurse, lab, pharmacy, finance, management) with KPIs and charts. | MUST |
| FR-ANL-02 | Multi-branch tenants MUST be able to view consolidated analytics with drill-down to a single branch. | MUST |
| FR-AUD-01 | The system MUST record an immutable audit entry for every create/update/delete on clinical and financial data and for sensitive reads. | MUST |
| FR-AUD-02 | Audit entries MUST capture actor, tenant, branch, action, target, timestamp, and source IP, and MUST be tamper-evident. | MUST |
| FR-SET-01 | The system MUST provide tenant-, branch-, and user-level settings (locale, notifications, security policy, catalogues). | MUST |

## 4.4 External Interface Requirements

### 4.4.1 User Interfaces

- A responsive React SPA supporting desktop, tablet, and mobile viewports, built on ShadCN UI components and TailwindCSS.

- All screens MUST present explicit loading, empty, and error states (detailed UI specs in Part 2).

- The UI MUST meet WCAG 2.1 AA for color contrast, keyboard navigation, and screen-reader labelling.

### 4.4.2 Software Interfaces

- REST API over HTTPS/JSON is the primary integration surface; all client and external access goes through it.

- Email and SMS provider APIs for notifications; pluggable behind a provider abstraction.

- Payment gateway APIs for online payments where the tenant enables them.

- S3-compatible object storage API for files; OpenSearch API for search/indexing.

- Laboratory device/external-lab interfaces over HL7, FHIR, and ASTM (LIS).

### 4.4.3 Communication Interfaces

- TLS 1.2+ for all external traffic; internal service traffic encrypted within the cluster.

- Asynchronous messaging via RabbitMQ for notifications, indexing, and report generation.

### 4.4.4 API Conventions

- Resource-oriented URLs, standard HTTP verbs, and consistent error envelopes with machine-readable codes.

- Cursor or offset pagination, filtering, sorting, and search parameters standardised across list endpoints.

- All requests carry tenant context resolved from the authenticated principal; cross-tenant access is impossible by contract.

## 4.5 Non-Functional Requirements

### 4.5.1 Performance

| ID | Requirement | Target / Measure |
| --- | --- | --- |
| NFR-01 | Read API endpoints MUST meet a p95 latency target under nominal load. | p95 < 300 ms |
| NFR-02 | Write API endpoints MUST meet a p95 latency target under nominal load. | p95 < 600 ms |
| NFR-03 | Patient search MUST return results quickly to support front-desk throughput. | p95 < 400 ms |
| NFR-04 | Queue state changes MUST propagate to subscribed clients in near-real-time. | < 2 s end-to-end |

### 4.5.2 Scalability

| ID | Requirement | Target / Measure |
| --- | --- | --- |
| NFR-05 | The platform MUST scale from 100 to 10,000 clinics without application rewrite via staged scaling of data, cache, broker, search, and storage. | Phased: 100 / 1,000 / 10,000 |
| NFR-06 | Services MUST be horizontally scalable (stateless API instances behind a load balancer). | Linear scale-out |
| NFR-07 | Hot tables MUST be designed for partitioning (e.g., by tenant and/or time) to sustain growth. | No table redesign at scale |

### 4.5.3 Availability & Reliability

| ID | Requirement | Target / Measure |
| --- | --- | --- |
| NFR-08 | The core platform MUST meet a monthly availability target. | ≥ 99.9% |
| NFR-09 | Asynchronous jobs MUST be retried with backoff and dead-lettered on persistent failure. | No silent loss |
| NFR-10 | The system MUST degrade gracefully when an optional dependency (search, SMS) is unavailable. | Core unaffected |
| NFR-11 | Recovery objectives MUST be defined and tested (RPO/RTO; detailed in DevOps part). | RPO ≤ 15 min, RTO ≤ 1 h |

### 4.5.4 Security & Privacy

| ID | Requirement | Target / Measure |
| --- | --- | --- |
| NFR-12 | Data MUST be encrypted in transit (TLS) and at rest (storage- and DB-level encryption). | TLS 1.2+; AES-256 at rest |
| NFR-13 | Authorisation MUST enforce role + scope (tenant/branch/department) + module flag on every protected operation. | Zero cross-scope access |
| NFR-14 | Secrets MUST be managed outside code via a secrets manager; no credentials in source. | 0 secrets in repo |
| NFR-15 | The system MUST provide an immutable, tamper-evident audit trail for clinical and financial actions. | 100% coverage |
| NFR-16 | Privacy controls inspired by HIPAA and GDPR MUST be supported: least-privilege access, data export, and right-to-erasure workflows subject to clinical retention law. | Controls available per tenant |
| NFR-17 | Sessions MUST expire on inactivity and support revocation; access tokens MUST be short-lived. | Configurable; default ≤ 15 min access token |

### 4.5.5 Usability

| ID | Requirement | Target / Measure |
| --- | --- | --- |
| NFR-18 | A new tenant MUST reach first-patient-registered quickly via guided onboarding. | < 15 minutes |
| NFR-19 | Common front-desk and clinical tasks MUST be achievable in minimal clicks with keyboard support. | Registration < 90 s |
| NFR-20 | The UI MUST meet WCAG 2.1 AA accessibility. | AA conformance |
| NFR-21 | The product MUST support localisation (locale, time zone, date/number formats). | i18n-ready |

### 4.5.6 Maintainability & Portability

| ID | Requirement | Target / Measure |
| --- | --- | --- |
| NFR-22 | Modules MUST have explicit boundaries and communicate via defined interfaces/events to enable later extraction to services. | No cross-module DB reach-in |
| NFR-23 | All SQL MUST be generated/checked via SQLC; schema changes MUST be migration-managed and reversible. | Versioned migrations |
| NFR-24 | The system MUST be containerised and deployable to any conformant Kubernetes cluster. | Cloud-agnostic |
| NFR-25 | Code MUST meet defined coverage and review gates before merge (see Testing part). | Coverage gate enforced |

### 4.5.7 Compliance & Data Retention

| ID | Requirement | Target / Measure |
| --- | --- | --- |
| NFR-26 | Audit log retention MUST follow the tenant's plan (90 days to configurable). | Per Table 3.2 |
| NFR-27 | On tenant cancellation, data MUST be retained for the configured grace period, then securely purged. | Policy-driven purge |
| NFR-28 | Clinical records MUST honour minimum legal retention before any erasure request is fulfilled. | Law-aware erasure |

## 4.6 Data Requirements

### 4.6.1 Core Data Entities (Logical)

The logical entities below anchor the database design in Part 2. Each tenant-owned entity carries a tenant identifier; branch-scoped entities also carry a branch identifier.

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

Table 4.1 — Logical data domains; full schema, types, constraints, and indexes are specified in Part 2.

### 4.6.2 Tenant Isolation

- Every tenant-owned row MUST carry a non-null tenant identifier; all queries MUST filter by the authenticated tenant.

- The data-access layer MUST apply tenant (and branch where relevant) predicates centrally so individual queries cannot omit them.

- Cross-tenant joins MUST be impossible by construction in the repository layer.

### 4.6.3 Soft Delete & Audit Strategy

- Clinical and financial records MUST use soft delete (deleted_at) rather than physical deletion to preserve history and audit integrity.

- Every mutating operation MUST emit an audit entry (FR-AUD-01/02); audit data is append-only.

- Signed clinical notes MUST be immutable; corrections are recorded as tracked amendments, never overwrites.

### 4.6.4 Data Volume Assumptions

| Phase | Clinics | Indicative Daily Encounters | Storage Growth Driver |
| --- | --- | --- | --- |
| A | ~100 | Up to ~30k | Attachments, lab reports |
| B | ~1,000 | Up to ~300k | Attachments, images, audit |
| C | ~10,000 | Up to ~3M | Imaging, audit, analytics snapshots |

Table 4.2 — Indicative volume assumptions informing partitioning and storage strategy (refined in Part 2).

## 4.7 Acceptance Criteria Patterns

Each functional requirement is verified against Given/When/Then acceptance criteria. The patterns below illustrate the form used per requirement in test specifications.

| Requirement | Given / When / Then |
| --- | --- |
| FR-PAT-03 (duplicate detection) | Given a patient with matching name + DOB + phone exists; When an operator attempts to create a new record; Then the system surfaces the likely match and requires explicit confirmation before saving. |
| FR-TEN-03 (feature flags) | Given the laboratory flag is off for a tenant; When any client calls a laboratory endpoint; Then the system returns a recoverable ‘module disabled’ error and the UI hides the module. |
| FR-LAB-05 (result lifecycle) | Given a result is in ‘entered’; When a user without validate permission attempts to approve it; Then the action is denied and audited, and the state is unchanged. |
| FR-PHA-02 (expiry) | Given the only available batch is expired; When a pharmacist attempts to dispense; Then dispensing is blocked with a clear reason and no stock is deducted. |
| NFR-13 (scope enforcement) | Given a Branch Manager assigned to Branch A; When they request Branch B operational data; Then access is denied and the attempt is audited. |
| NFR-08 (availability) | Given a measurement window of one month; When uptime is computed excluding scheduled maintenance; Then availability is ≥ 99.9%. |

Table 4.3 — Acceptance-criteria patterns; full criteria accompany each requirement in the Testing Strategy (Part 2).

## 4.8 Traceability

Every functional requirement (FR-*) traces forward to one or more module API contracts and UI screens in Part 2 and to test cases in the Testing Strategy; every non-functional requirement (NFR-*) traces to an architectural decision and a verification method (load test, security test, or monitoring SLO). The identifier scheme established here is the spine of that traceability matrix.