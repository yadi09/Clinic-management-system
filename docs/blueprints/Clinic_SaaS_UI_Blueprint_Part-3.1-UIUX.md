# Source: Clinic_SaaS_UI_Blueprint_Part-3.1-UIUX.docx

Clinic Management SaaS Platform

Implementation-Ready Blueprint

Part 4 — Per-Role UI/UX Walkthroughs (Login to Every Screen)

| Document | Part 4: Per-Role UI/UX Walkthroughs |
| --- | --- |
| Section | 10 (extends the Part 3 UI/UX Specification) |
| Coverage | Every user, individually — platform tier (SaaS owner, super admin, support, billing) and tenant tier (owner, branch mgr, doctor, nurse, reception, lab, pharmacy, inventory, cashier, accountant, HR) + patient portal |
| Per role | Scope · login & entry · landing · every screen in detail · key flows |
| Diagrams | Hierarchy & config cascade, onboarding, login, auth flow, and role consoles — each on its own page |
| Status | Implementation-ready draft v3 |

# Contents

10. Per-Role UI/UX Walkthroughs

Foundations

10.1 Purpose & How to Read This Section

10.2 Role Hierarchy & Configuration Cascade

10.3 Shared Authentication & Session Experience

Platform tier

10.4 SaaS Owner (Platform Owner)

10.5 Platform Super Admin

10.6 Platform Support / Operations

10.7 Platform Billing & Accounts

Tenant administration

10.8 Tenant Owner / Clinic Administrator

10.9 Branch Manager

Clinical & front office

10.10 Doctor / Physician

10.11 Nurse

10.12 Receptionist / Front Desk

Ancillary services

10.13 Lab Technician

10.14 Lab Manager

10.15 Pharmacist

10.16 Pharmacy Manager

10.17 Inventory Manager

Finance

10.18 Cashier / Billing Clerk

10.19 Accountant / Finance (Tenant)

HR & patient

10.20 HR Manager

10.21 Patient (Portal)

Cross-role

10.22 Navigation & Permission Visibility

# 10. Per-Role UI/UX Walkthroughs

Every user of the platform, specified individually — from the SaaS owner at the top of the hierarchy down to the patient — each with their login, landing, navigation, and every screen they can reach, in detail. This part operationalises the design system and patterns of Part 3 for each distinct role.

## 10.1 Purpose & How to Read This Section

Part 3 defined the shared design language, component library, shell, and interaction patterns. This part applies them per role so that implementation can proceed one persona at a time without gaps. Roles are grouped into two tiers — the platform tier (the SaaS vendor’s own staff who operate the multi-tenant product) and the tenant tier (a clinic’s own users) — plus the patient portal.

Each role is documented with the same template:

- Role & scope — who they are and what data/branches they may touch.

- Login & entry — where they sign in and where they land afterwards.

- Landing / dashboard — the first screen and its widgets.

- Screen catalog — a table of every primary screen the role can reach, with its purpose, key elements and actions, and its states/scope. This is the page-by-page specification.

- Key flows — the role’s most important end-to-end journeys.

All screens reuse the shell, components, and the four mandatory states (loading, empty, error, populated) from Part 3; only role-specific content is described here. Navigation items and actions appear only when the role’s permissions allow and the tenant’s feature flag is enabled.

## 10.2 Role Hierarchy & Configuration Cascade

Configuration flows top-down. The SaaS owner provisions a tenant and assigns a plan; the tenant owner configures the clinic (branches, departments, users, flags, branding); branch managers and department leads configure their areas; and the experience each end-user sees is the product of those decisions plus their role. No user can grant themselves capabilities above their tier.

Figure 10.1 — Role hierarchy and configuration cascade: platform tier → tenant tier → end users.

Tenant provisioning and first-run configuration follow a guided sequence, from tenant creation by the SaaS owner through the tenant owner’s onboarding wizard to go-live.

Figure 10.2 — Provisioning & onboarding sequence (SaaS owner → tenant owner → go-live).

## 10.3 Shared Authentication & Session Experience

Every role enters through the same authentication experience, differentiated only by entry URL and post-login routing. Tenant users sign in at their workspace (a tenant subdomain); platform staff sign in at the separate admin domain. MFA is mandatory for platform staff and for any tenant role with administrative or financial privileges, and optional-but-encouraged otherwise.

Figure 10.3 — Shared sign-in screen (workspace, credentials, SSO, MFA).

#### Login screen elements

- Workspace field. Pre-filled from the subdomain; lets users on a shared device confirm the tenant. Platform staff see the platform context instead.

- Credentials + SSO. Email and password, or single sign-on (SAML/Google) when the tenant has configured it; “keep me signed in” respects device-trust policy.

- MFA step. When enabled, a 6-digit TOTP step follows; recovery codes and “trust this device” are available.

- States. Inline error for invalid credentials (no account enumeration), lockout after repeated failures, password-reset link, and disabled-account / suspended-tenant messages.

After authentication the system resolves tenant, role, and scope and routes the user to their role-specific landing page; the session refreshes silently and re-prompts on expiry.

Figure 10.4 — Authentication & session flow.

## 10.4 SaaS Owner (Platform Owner)

Scope. The highest-privilege platform account. Owns every tenant, the subscription plans, platform-wide settings, billing, and the platform team. Cannot read individual patient clinical data without an explicit, consented, audited support session (impersonation). Sees aggregate, not clinical, information by default.

Login & entry. Signs in at the admin domain with mandatory MFA; lands on the Platform Overview.

Landing. Platform overview with portfolio KPIs (active tenants, MRR, trials, churn, API volume), a recent-tenants table, system-health indicators, and an attention list (past-due accounts, ending trials, plan-limit breaches).

Figure 10.5 — SaaS Owner: platform overview console.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Platform Overview | Portfolio health at a glance | KPI cards; recent-tenants table; system-health tiles; attention list; create-tenant CTA | Live; aggregate only |
| Tenants — list | Find & manage all tenants | Search/filter by plan/status/region; columns plan, branches, users, MRR, status; row → detail | Sortable, paginated |
| Tenant — detail | Inspect & administer one tenant | Account info; plan & limits; feature flags; usage; activity; actions: change plan, impersonate, suspend/cancel | Actions audited |
| Create tenant | Provision a new account | Name, slug/subdomain, plan, region, owner email → sends owner invite | Validation; idempotent |
| Plans & billing | Define commercial offering | Plan tiers, limits, prices, add-ons; subscriptions; invoices; dunning rules | Platform-wide |
| Feature flags | Global & per-tenant flags | Default flags per plan; per-tenant overrides; rollout toggles | Change history |
| Usage & limits | Monitor consumption vs plan | Per-tenant usage (visits, API, storage, SMS); limit alerts; export | Time-ranged |
| System health | Operational telemetry | API latency/error rate, queue depth, DB replication, region status (links to Grafana) | Live, read-only |
| Platform team | Manage platform staff | Invite/disable platform admins & support; assign platform roles; MFA status | Owner-only |
| Audit | Platform-level audit trail | Immutable log of platform actions (plan changes, impersonations, suspensions); filter & export | Append-only |
| Settings | Platform configuration | Branding defaults, email/SMS providers, security policy, regions, legal docs | Owner-only |

Key flows. Create a tenant and assign a plan (Fig 10.2); upgrade/downgrade a tenant’s plan; investigate a past-due account and trigger dunning; open a consented support session into a tenant; raise a per-tenant feature flag for a pilot.

Figure 10.6 — SaaS Owner: tenant detail with plan, flags, usage, and lifecycle actions.

## 10.5 Platform Super Admin

Scope. Delegated platform administration and operations. Can do most of what the owner can except change ownership, top-level billing terms, and a few owner-reserved settings. Day-to-day operations, support escalations, and incident response live here.

Login & entry. Admin domain, mandatory MFA; lands on the Operations console.

Landing. Operations console: open tickets, SLA breaches, failed background jobs, and active impersonation sessions, with the support queue front and centre.

Figure 10.7 — Platform Super Admin: operations console.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Operations console | Run the platform day-to-day | Ops KPIs; support queue; impersonation panel; background-job health | Live |
| Support tickets | Handle tenant issues | Ticket list with priority/SLA; thread; link to tenant; status workflow | SLA-tracked |
| Impersonation | Consented support sessions | Start time-boxed, read-only-by-default session into a tenant; banner while active; full audit | Audited, expiring |
| Flag overrides | Toggle flags for a tenant | Search tenant; enable/disable module; reason note | Audited |
| Background jobs | Queue & worker health | Per-queue status, retries, dead-letter; requeue/inspect failed jobs | Live |
| Audit log | Investigate actions | Cross-tenant platform actions; filter by actor/target/time; export | Append-only |
| Security | Posture & sessions | Active sessions, MFA enforcement, suspicious-activity alerts, key rotation | Admin-only |
| Team & roles | Manage platform staff (delegated) | Invite support/ops; assign roles within owner-set bounds | Owner-bounded |

Key flows. Triage a support ticket and open a read-only impersonation session to reproduce it; requeue failed report-generation jobs; investigate an audit trail for a tenant; enable a flag at a tenant’s request.

## 10.6 Platform Support / Operations

Scope. Front-line support. Reads tenant account metadata and runs consented, read-only support sessions; cannot change plans, billing, or platform settings. Every elevated action requires an active ticket and is audited.

Login & entry. Admin domain, MFA; lands on “My support queue.”

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| My queue | Tickets assigned to me | Prioritised list; quick filters; open ticket | SLA timers |
| Ticket detail | Resolve a request | Conversation, tenant context, canned responses, escalate, request impersonation | Status workflow |
| Tenant lookup | Find a tenant’s account | Read-only account summary: plan, status, branches, contacts, recent activity | Read-only |
| Support session | Reproduce an issue | Consented, read-only impersonation with persistent banner; auto-expires | Audited |
| Knowledge base | Reference & macros | Articles, runbooks, response templates | Read-only |

Key flows. Pick up a ticket, look up the tenant, request a consented session, document the resolution, and escalate to a super admin if a configuration change is required.

## 10.7 Platform Billing & Accounts

Scope. Manages the vendor’s commercial relationship with tenants: subscriptions, invoices, payments, dunning, and revenue reporting at the platform level. No access to tenant clinical or tenant-internal financial data.

Login & entry. Admin domain, MFA; lands on the Revenue dashboard.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Revenue dashboard | Platform commercial health | MRR/ARR, new vs churned, trials converting, failed payments | Aggregate |
| Subscriptions | Manage tenant subscriptions | List by status; change cycle; apply credits; cancel/renew | Audited |
| Invoices | Platform billing to tenants | Issue/void; line items; download; payment status | Per tenant |
| Payments & dunning | Collections | Failed-payment queue; retry schedule; dunning emails; suspension triggers | Workflow |
| Reports & exports | Finance reporting | Revenue, tax, payout exports (CSV); date ranges | Export |

Key flows. Work the failed-payment queue and advance dunning; apply a credit; export monthly revenue for finance; flag a tenant for suspension after dunning exhaustion (handed to the owner/super admin).

## 10.8 Tenant Owner / Clinic Administrator

Scope. Owns the tenant. Configures the clinic across all branches: organisation structure, users and roles, feature flags (within the plan), price lists, branding, and tenant settings. Sees tenant-wide operational and financial summaries. First user created when the tenant is provisioned.

Login & entry. Tenant workspace subdomain, mandatory MFA. On first login, the onboarding wizard (Fig 10.2) runs; thereafter lands on the tenant admin overview.

Landing. Tenant overview: cross-branch KPIs (visits, revenue, utilisation), plan usage vs limits, staff activity, and setup-completeness prompts during onboarding.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Onboarding wizard | First-run configuration | Stepper: clinic profile → branches → departments → roles & users → flags & price lists → branding → go live; save & resume | First run; resumable |
| Tenant overview | Cross-branch health | KPI cards; plan usage vs limits; staff activity; alerts | Tenant-wide |
| Clinic profile | Identity & locale | Name, timezone, locale, logo, contact, legal details | Audited |
| Branches | Manage locations | List/add/edit branches; address, hours, status; per-branch defaults | Tenant-wide |
| Departments | Specialty units per branch | Add/edit departments; assign specialty & default form set | Per branch |
| Users | Staff accounts | Invite/edit/deactivate; assign role + scope (branch/department); MFA status; resend invite | Limit-aware |
| Roles & permissions | Access control | System roles + custom roles; permission matrix; scope rules | Tenant-wide |
| Feature flags | Enable modules | Toggle pharmacy/lab/inventory/insurance/telemedicine/hr/finance_advanced within plan; upgrade prompt if not in plan | Plan-bounded |
| Price lists & discounts | Commercial config | Per-branch service prices; discount rules & approval thresholds; tax | Per branch |
| Branding & templates | White-label | Brand colours (contrast-checked), logo, document letterhead for invoices/prescriptions/reports | Tenant-wide |
| Subscription & usage | Plan management | Current plan, limits, usage; request upgrade; invoices from vendor | Read + request |
| Settings | Tenant preferences | Notifications, working hours, numbering schemes, integrations, data-retention | Tenant-wide |
| Audit log | Tenant activity trail | Filter by user/action/branch/time; export | Append-only |
| Reports | Operational & financial | Cross-branch dashboards & exports | Tenant-wide |

Key flows. Complete onboarding to go-live; add a branch and its departments; invite a doctor and scope them to a branch; enable the laboratory module; set branch price lists; apply tenant branding to documents.

## 10.9 Branch Manager

Scope. Administers one branch (or several, if assigned): its staff scheduling, departments, local settings, and operational/financial performance for that branch. Cannot change tenant-wide plan, flags, or other branches.

Login & entry. Workspace subdomain; MFA recommended; lands on the branch dashboard for the active branch (scope switcher if managing several).

Landing. Branch dashboard: today’s visits, queue load, revenue, staff on shift, and exceptions (no-shows, pending results, low stock).

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Branch dashboard | Run the branch | KPI cards; live queue summary; revenue; staff on shift; exceptions | Active branch |
| Staff & schedules | Workforce for the branch | Roster, shifts, provider availability/slots; leave; coverage gaps | Branch-scoped |
| Departments | Local department setup | Manage department config, resources/rooms, default forms | Branch-scoped |
| Appointments overview | Branch-wide scheduling | All providers’ calendars; capacity; reassignments | Branch-scoped |
| Queue monitor | Live operations | Department queues, wait times, escalate/reassign | Branch-scoped |
| Branch reports | Performance | Visits, utilisation, revenue, turnaround; export | Branch-scoped |
| Branch settings | Local preferences | Hours, rooms/resources, local price overrides (if permitted) | Branch-scoped |

Key flows. Publish next week’s provider availability; resolve a coverage gap; monitor and rebalance queues across departments; review branch revenue and utilisation.

## 10.10 Doctor / Physician

Scope. Clinical work for their patients within assigned branch(es)/department(s): consultations, EMR, prescriptions, orders, and review of results. Sees clinical data for patients in scope; no platform or billing administration.

Login & entry. Workspace subdomain; MFA per tenant policy; lands on “My day” — schedule and patients waiting.

Landing. Doctor dashboard: my schedule, patients waiting in queue, pending results to review, and unsigned notes.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| My day (dashboard) | Start clinical work | My schedule; patients waiting; pending results; unsigned notes | My scope |
| My schedule | Today’s appointments | Time-ordered list/calendar; start consultation; running-late | My calendar |
| Patient search / record | Open a patient | Search; demographics, history timeline, allergies, attachments, results | In-scope patients |
| Consultation workspace | Document an encounter | Patient banner + allergy alerts; SOAP editor; vitals; diagnoses (ICD); auto-save; sign & close | Open until signed |
| Prescription | Prescribe safely | Add medications; allergy/interaction checks block unsafe orders; sign | Safety-gated |
| Lab orders | Order investigations | Select tests/panels; priority; status tracking | Flag: laboratory |
| Dynamic forms | Specialty capture | Render versioned form schema; validate; attach to encounter | Per department |
| Results review | Act on results | Inbox of new/critical results; acknowledge; attach to encounter; notify patient | My patients |
| Referrals & follow-ups | Continuity | Create referral; schedule follow-up; instructions | In-scope |

Figure 10.8 — Doctor: consultation & EMR workspace (clinical-safety alerts, history).

Key flows. Pick the next waiting patient, document a SOAP note, record vitals and an ICD diagnosis, prescribe (with allergy blocking), order labs, and sign & close — which raises charges and notifications automatically (Section 5.5).

## 10.11 Nurse

Scope. Triage, vitals capture, and assisting clinical workflows within assigned branch/department. Can record vitals and nursing notes, manage the queue, and support the doctor; cannot sign physician notes or prescribe.

Login & entry. Workspace subdomain; lands on the triage/queue view.

Landing. Vitals & queue: patients waiting for triage, those in progress, and tasks (e.g., vaccinations, dressings).

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Triage / queue | Manage waiting patients | Queue board; call patient; set priority; start triage | Department-scoped |
| Vitals capture | Record measurements | BP, HR, temp, SpO₂, weight, height, BMI; validation & ranges; save to encounter | Per encounter |
| Nursing notes | Document care | Structured nursing note; tasks performed; attach to encounter | Cannot sign MD notes |
| Patient record (read) | Context for care | Allergies, history, current meds, orders | In-scope, read-mostly |
| Task list | Procedures & follow-ups | Assigned nursing tasks (injections, dressings); mark done | Department-scoped |

Key flows. Call and triage a waiting patient, capture vitals into the encounter, complete an assigned procedure, and pass the patient to the doctor.

## 10.12 Receptionist / Front Desk

Scope. Front-of-house for a branch: register patients, book/reschedule appointments, check patients in, manage the queue, and take payments at the desk. No clinical documentation.

Login & entry. Workspace subdomain; lands on the front-desk dashboard (today’s appointments + check-in queue).

Landing. Front-desk dashboard: today’s appointments, check-in queue, new registrations, and unbilled visits.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Front-desk dashboard | Run the desk | Today’s appointments; check-in queue; quick actions (register, book, collect) | Active branch |
| Patient search | Find or create patient | Search by name/MRN/phone; create new | In-scope |
| Register patient | New patient record | 3-step wizard; duplicate detection; inline validation; consents | Branch-scoped |
| Appointment calendar | Schedule visits | Day/week/month; book/reschedule/cancel; provider & resource | Branch-scoped |
| Check-in | Arrive a patient | Confirm details & insurance; add to queue; collect co-pay | Per visit |
| Queue board | Manage flow | Waiting → called → in consult → done; reassign; no-show | Department/branch |
| Desk payments | Collect at desk | Take payment against an invoice; print receipt | Branch-scoped |
| Patient documents | Hand over paperwork | Print/issue forms, receipts, appointment cards | In-scope |

Figure 10.9 — Receptionist: live queue board (also uses registration and scheduling, Figs 9.5–9.6).

Key flows. Register a new patient (with duplicate check), book an appointment, check the patient in and collect a co-pay, and manage the live queue through to completion.

## 10.13 Lab Technician

Scope. Processes laboratory work for the branch: accessioning samples, entering results, and submitting them for validation. Visible only when the laboratory flag is enabled. Cannot approve results (that is the lab manager / authorised role).

Login & entry. Workspace subdomain; lands on the sample worklist.

Landing. Worklist: pending collections, samples in process, and items awaiting result entry, with critical flags highlighted.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Worklist | Today’s lab work | Tabs: ordered · collected · in-process · resulted; filters; barcode scan | Flag: laboratory |
| Accession sample | Receive & label | Scan/generate barcode; confirm patient & test; record collection time | Per sample |
| Result entry | Enter values | Per-test fields with units & reference ranges; auto-flag high/low/critical; CSV/device import; save → submit for validation | Cannot approve |
| Order detail | Context for an order | Tests, patient, specimen, status history | In-scope |
| Critical values | Escalate urgent results | Critical queue; mark notified | Highlighted |

Key flows. Accession an incoming sample by barcode, enter results with automatic range flagging, and submit for validation; escalate a critical value.

## 10.14 Lab Manager

Scope. Oversees the lab: validates/approves results, configures the test catalog and reference ranges, and monitors turnaround. Inherits technician abilities plus approval and configuration.

Login & entry. Workspace subdomain; lands on the validation queue.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Validation queue | Approve results | Entered results awaiting validation; review, amend, approve → releases result event | Approver |
| Test catalog | Configure tests | Tests & panels, specimen types, units, reference ranges (age/sex-aware), pricing | Flag: laboratory |
| Worklist (all) | Lab operations | All samples across technicians; reassign; status | Branch lab |
| Turnaround & QA | Quality monitoring | TAT metrics, pending/overdue, rejection reasons | Reports |
| Devices / imports | Instrument integration | Import mappings, device status, manual import | Config |

Key flows. Validate and approve a batch of results (releasing them to the doctor and billing); add a new test with reference ranges; review turnaround for the week.

## 10.15 Pharmacist

Scope. Dispenses medications against prescriptions and over-the-counter, manages batches/expiry at the branch. Visible only when the pharmacy flag is enabled.

Login & entry. Workspace subdomain; lands on the dispense queue.

Landing. Dispense queue: signed prescriptions awaiting dispensing, plus near-expiry and low-stock alerts.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Dispense queue | Fulfil prescriptions | Signed Rx list; open to dispense; allergy/interaction recheck | Flag: pharmacy |
| Dispense | Issue medication | Select batch (FEFO); quantity; counselling notes; record → decrements stock, raises charge | Audited |
| OTC sale | Counter sales | Add items; price; payment/invoice link | Branch-scoped |
| Drug catalog | Reference | Search drugs, classification, forms, interactions | Read |
| Batches & expiry | Stock by batch | On-hand by batch; expiry alerts; quarantine/return | Branch-scoped |

Key flows. Open a signed prescription, confirm against allergies, dispense from the earliest-expiry batch, and counsel the patient — stock decrements and a pharmacy charge are raised automatically.

## 10.16 Pharmacy Manager

Scope. Manages the pharmacy catalog, purchasing, and stock control across the branch; inherits pharmacist abilities plus procurement and configuration.

Login & entry. Workspace subdomain; lands on the pharmacy operations dashboard.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Pharmacy dashboard | Stock & sales health | Low-stock & expiry alerts; dispensing volume; value on hand | Branch-scoped |
| Drug catalog admin | Maintain catalog | Add/edit drugs, classifications, pricing, controlled flags | Flag: pharmacy |
| Purchasing | Replenish stock | Purchase orders, suppliers, goods receipts | Branch-scoped |
| Stock control | Counts & adjustments | Batch counts, adjustments, returns, quarantine | Audited |
| Reports | Pharmacy analytics | Consumption, margins, wastage/expiry | Reports |

Key flows. Raise a purchase order to a supplier, receive goods into batches, run an expiry review, and reconcile a stock count.

## 10.17 Inventory Manager

Scope. Manages non-drug consumables and supplies: stock levels, inter-branch transfers, and purchasing. Visible only when the inventory flag is enabled.

Login & entry. Workspace subdomain; lands on the inventory dashboard.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Inventory dashboard | Stock overview | Low-stock alerts; reorder suggestions; value on hand | Branch/tenant |
| Items | Catalog of supplies | Add/edit items, SKUs, units, reorder levels | Flag: inventory |
| Stock levels | On-hand by branch | Per-item per-branch quantities; adjust | Branch-scoped |
| Transfers | Move stock | Create/approve inter-branch transfers; dispatch/receive | Multi-branch |
| Purchasing | Procure supplies | Purchase requests → orders → receipts | Audited |
| Stock counts | Audit stock | Counts with variance; approve adjustments | Audited |

Key flows. Review reorder suggestions and raise a purchase request; transfer stock from a central branch to a satellite; reconcile a physical count.

## 10.18 Cashier / Billing Clerk

Scope. Handles patient-facing money at the branch: builds invoices from accrued charges, takes payments, applies permitted discounts, and submits insurance claims. No clinical documentation; financial configuration is the accountant’s.

Login & entry. Workspace subdomain; MFA per policy; lands on unbilled visits & open invoices.

Landing. Billing worklist: unbilled visits, open/partially-paid invoices, and today’s collections.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Billing worklist | Find work | Unbilled visits; open invoices; today’s collections; search | Branch-scoped |
| Invoice | Bill a visit | Itemised charges (consultation/lab/pharmacy); discounts (approval-gated); totals; issue | Per visit |
| Take payment | Collect | Cash/card/gateway/insurance; partial payments; receipt/PDF | Audited |
| Refunds | Reverse a payment | Refund against payment with reason; approval if required | Approval-gated |
| Insurance claim | Bill the payer | Build claim from invoice; submit; track status | Flag: insurance |
| Daily cash report | End-of-shift | Cash drawer reconciliation; payment breakdown | Per shift |

Figure 10.10 — Cashier: invoice with itemised charges, insurance, and payment actions.

Key flows. Assemble a visit’s charges into an invoice, apply an approved discount, take a part-cash/part-insurance payment, submit the claim, and reconcile the drawer at end of shift.

## 10.19 Accountant / Finance (Tenant)

Scope. Tenant-internal finance: oversees revenue, accounts receivable, claims, price lists, tax, and financial reporting across branches. The “Accounts” function. Configures financial settings the cashier operates within.

Login & entry. Workspace subdomain; mandatory MFA; lands on the finance dashboard.

Landing. Finance dashboard: revenue (MTD), outstanding AR with aging, claims pipeline, and collections, plus a task list (approvals, reconciliations, month-end).

Figure 10.11 — Accountant: finance dashboard (revenue, AR aging, claims, tasks).

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Finance dashboard | Financial health | Revenue, AR, claims, collections; tasks; export/month-end | Tenant/branch |
| Invoices (all) | Oversee billing | All invoices across branches; filter by status; void/adjust (gated) | Tenant-wide |
| Payments & refunds | Money movement | Payment ledger; approve refunds; reconcile | Audited |
| Insurance claims | Payer pipeline | Submitted/approved/rejected/reimbursed; resubmit; post reimbursements | Flag: insurance |
| AR / aging | Collections | Aging buckets (0–30–60–90+); follow-up actions; statements | Tenant-wide |
| Price lists & discounts | Commercial config | Maintain prices per branch; discount rules & approval thresholds; tax | Config |
| Financial reports | Reporting | Revenue by service/branch/provider; tax; exports | Tenant-wide |
| Tax & settings | Finance configuration | Tax rates, numbering, ledgers, period close | Config |

Key flows. Approve pending discounts; work the AR aging and issue statements; post insurance reimbursements and resubmit a rejected claim; run and lock the month-end close.

## 10.20 HR Manager

Scope. Workforce administration for the tenant: staff directory, attendance and shifts, leave, and HR documents. Visible only when the hr flag is enabled. No clinical or financial-ledger access.

Login & entry. Workspace subdomain; MFA per policy; lands on the HR dashboard.

Landing. HR dashboard: headcount, on-shift now, pending leave requests, and expiring credentials/documents.

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| HR dashboard | Workforce overview | Headcount; on-shift; pending leave; expiring credentials | Flag: hr |
| Staff directory | People records | Profiles, roles, contact, employment details, documents | Tenant-wide |
| Attendance & shifts | Time & rostering | Shift schedules, clock-in/out, coverage | Branch/tenant |
| Leave | Absence management | Requests, approvals, balances, calendar | Workflow |
| Documents & credentials | Compliance | Contracts, licences, certifications with expiry reminders | Audited |
| HR reports | Analytics | Attendance, leave, turnover; export | Reports |

Key flows. Approve a leave request and update coverage; onboard a new staff member’s HR record and documents; act on an expiring-licence reminder.

Note: staff accounts and access (roles/scopes/MFA) remain with the tenant owner/admin in Users & Roles (10.8); HR manages employment data, not authentication.

## 10.21 Patient (Portal)

Scope. Self-service for the patient: their own appointments, results, documents, and balances for the tenant(s) they belong to. Sees only their own data (and dependents they are linked to as guardian).

Login & entry. Patient portal (tenant-branded), email/phone + password or one-time code; mobile-first. Lands on the patient home.

Landing. Patient home: upcoming appointments, new results, outstanding balance, and quick actions (book, message, pay).

#### Screen catalog

| Screen | Purpose | Key elements & primary actions | States / scope |
| --- | --- | --- | --- |
| Patient home | Self-service overview | Upcoming visits; new results; balance; book / pay quick actions | Own data |
| Book appointment | Self-scheduling | Choose branch, specialty, provider, slot; reason; confirm | Own / dependents |
| My appointments | Manage visits | Upcoming & past; reschedule/cancel; add to calendar; directions | Own |
| My records & results | Health information | Visit summaries, results (when released), prescriptions, allergies | Own, released-only |
| Documents | Files & forms | Download reports/receipts; complete pre-visit forms (dynamic) | Own |
| Invoices & payments | Pay bills | Outstanding invoices; pay online; receipts | Own |
| Profile & preferences | Account self-service | Contact details, communication preferences, password & MFA, linked dependents | Own |

Key flows. Book a visit, complete a pre-visit form, attend, then view the released results and pay the invoice — all mobile-first (Section 9.10).

Results and documents appear only when released by the clinic; sensitive results may be gated behind a provider conversation per tenant policy.

## 10.22 Navigation & Permission Visibility

Which top-level areas each role sees. Visibility is the intersection of role permission and tenant feature flag; flag-gated areas (laboratory, pharmacy, inventory, insurance, hr) appear only when enabled. Platform-tier areas exist only in the admin domain.

#### Platform tier (admin domain)

| Area | Visible to |
| --- | --- |
| Platform overview / tenants | SaaS Owner, Super Admin (Support: read-only) |
| Plans & billing | SaaS Owner, Platform Billing |
| Feature flags / settings | SaaS Owner (Super Admin: overrides) |
| Operations / support / jobs | Super Admin, Support |
| Impersonation (consented) | Super Admin, Support |
| Platform audit | SaaS Owner, Super Admin |
| Revenue / subscriptions / dunning | Platform Billing, SaaS Owner |

Table 10.1 — Platform-tier navigation visibility.

#### Tenant tier (workspace)

| Area | Visible to |
| --- | --- |
| Admin (clinic, branches, users, roles, flags, branding) | Tenant Owner/Admin; Branch Manager (branch-scoped subset) |
| Dashboard | All staff (role-shaped content) |
| Patients | Reception, Doctor, Nurse (and clinical roles) |
| Appointments & Queue | Reception, Nurse, Doctor, Branch Manager |
| Consultation / EMR | Doctor (full), Nurse (vitals/notes) |
| Laboratory | Lab Technician, Lab Manager, Doctor (orders/results) — flag: laboratory |
| Pharmacy | Pharmacist, Pharmacy Manager — flag: pharmacy |
| Inventory | Inventory Manager, Pharmacy Manager — flag: inventory |
| Billing & Payments | Cashier, Accountant, Branch Manager |
| Insurance claims | Cashier, Accountant — flag: insurance |
| Finance config / reports | Accountant (Branch Manager: branch reports) |
| HR | HR Manager — flag: hr |
| Reports | Owner/Admin, Branch Manager, Accountant, area managers (scoped) |
| Portal | Patient only |

Table 10.2 — Tenant-tier navigation visibility (intersection of role and feature flag).

Permission principles. Every screen and action is gated server-side by role + scope (branch/department) + feature flag; the UI hides what a user cannot do rather than showing disabled dead-ends (except flag-gated modules, which show an upgrade prompt to admins). Scope narrows data to the user’s assigned branch(es)/department(s); cross-tenant access is impossible by construction (Sections 5.7, 8.9). All privileged and clinical actions are audited.