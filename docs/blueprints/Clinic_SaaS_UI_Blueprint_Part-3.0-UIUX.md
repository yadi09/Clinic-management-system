# Source: Clinic_SaaS_UI_Blueprint_Part-3.0-UIUX.docx

Clinic Management SaaS Platform

Implementation-Ready Blueprint

Part 3 — UI/UX Specification

| Document | Part 3: UI/UX Specification |
| --- | --- |
| Section | 9 (continues from Parts 1 & 2) |
| Design system | Tokens → Tailwind + ShadCN UI · healthcare blue/teal · light & dark themes |
| Covers | Design language, components, app shell, screens & wireframes, flows, accessibility, i18n, theming |
| Diagrams | Annotated wireframes, IA map, and primary user flow — each on its own full page |
| Status | Implementation-ready draft v3 |

# Contents

9. UI/UX Specification

9.1 Overview & Design Principles

9.2 Design Language & Visual System

9.3 Component Library

9.4 Application Shell & Navigation

9.5 Information Architecture & Screen Inventory

9.6 Interaction Patterns

9.7 Key Screens & Wireframes

9.8 Primary User Flow

9.9 Role-Based UI & Landing Experiences

9.10 Responsive & Device Strategy

9.11 Accessibility (WCAG 2.1 AA)

9.12 Localization, Internationalization & RTL

9.13 Theming & Multi-Tenant Branding

9.14 Microcopy & Content Guidelines

9.15 Notifications & Feedback Patterns

9.16 Design-to-Development Handoff

# 9. UI/UX Specification

A calm, fast, role-aware interface for busy clinical teams: a single design system, a consistent application shell, and screens engineered around safety, speed, and clarity — accessible, responsive, localisable, and white-labelable per tenant.

## 9.1 Overview & Design Principles

- Safety first. The interface actively prevents clinical error — allergy and interaction alerts, explicit confirmation for destructive or irreversible actions, and unambiguous status. The patient banner and alerts are always visible during clinical work.

- Speed for repeat users. Frequent tasks (register, book, check-in, document, dispense, bill) are reachable in the fewest interactions, with keyboard support, sensible defaults, and inline creation rather than page hops.

- Clarity over decoration. A restrained healthcare palette, generous whitespace, and a strict type scale keep dense clinical data readable; colour carries meaning (status), never decoration alone.

- Consistency. One shell, one component library, one set of interaction patterns across all 31 modules, so a learned behaviour transfers everywhere.

- Context, not navigation. The active patient, branch, and encounter travel with the user; screens show what matters now and defer the rest to drawers and progressive disclosure.

- Inclusive by default. WCAG 2.1 AA, full keyboard operability, and localisation (including RTL) are baseline requirements, not enhancements.

## 9.2 Design Language & Visual System

Design decisions are encoded as tokens (colour, type, spacing, radius, elevation, motion) consumed by Tailwind and the ShadCN component layer, so the entire product re-themes from a single source and tenants can be branded without code changes (Section 9.13).

Figure 9.1 — Core design tokens: colour roles, neutrals/surfaces, type scale, radius and spacing.

#### Colour roles

| Token | Value | Use |
| --- | --- | --- |
| primary | #1F4E79 | Primary actions, headers, active nav, key figures |
| secondary | #2E86AB | Links, secondary emphasis, informational accents |
| accent | #148F77 | Positive primary CTAs (save/confirm), success |
| warning | #C9821B | Caution states, waiting, near-expiry, pending |
| danger | #C0392B | Errors, destructive actions, critical clinical alerts |
| muted / border / surface | #6B7280 / #D5DCE5 / #F2F7FB | Secondary text, dividers, panel and row backgrounds |

Table 9.1 — Semantic colour tokens (light theme; a dark theme maps the same roles).

#### Typography

A single UI typeface (Inter, with a system-UI fallback stack) on a modular scale. Numerals are tabular in tables and totals. Line length in reading areas is capped (~70–75 characters) for legibility.

| Style | Size / Weight | Usage |
| --- | --- | --- |
| Display / H1 | 26px / 700 | Page titles |
| Section / H2 | 21px / 700 | Section headers within a page |
| Subsection / H3 | 17px / 700 | Card and group titles |
| Body | 14px / 400 | Default content |
| Small / caption | 12px / 400 | Helper text, metadata, table captions |
| Micro / label | 10.5px / 700 | Field labels, chips, eyebrow text |

Table 9.2 — Type scale.

#### Spacing, grid, elevation & motion

- Spacing. 8px base grid; steps of 4 · 8 · 12 · 16 · 24 · 32 · 48. Layout uses a 12-column responsive grid with a max content width on very wide screens.

- Radius. 4px (inputs/cells), 8px (cards), 14px (modals), pill (chips, toggles).

- Elevation. Four levels — 0 flat, 1 card, 2 popover/menu, 3 modal/dialog — expressed as soft shadows; never used to imply status.

- Motion. Fast and purposeful: 120–160ms ease-out for entrances, 90ms for state changes; respect prefers-reduced-motion by disabling non-essential animation.

- Iconography. One line-icon set (Lucide), 1.5px stroke, 16/20/24px sizes, always paired with a text label or accessible name.

## 9.3 Component Library

Built on ShadCN UI primitives composed into product components (Section 6.3). Every interactive component specifies its full state set — default, hover, focus (visible ring), active, disabled, loading, error — and an accessible name.

| Component | Variants / States | Notes |
| --- | --- | --- |
| Button | primary · accent · secondary · ghost · destructive; loading, disabled | One primary action per view; destructive requires confirm |
| Input / Select / Date | default · focus · error · disabled · read-only | Label + helper + error slot; 44px min touch target |
| Data table | sortable · filterable · paginated · selectable · empty · loading | Sticky header, column density toggle, bulk action bar |
| Dialog / Drawer / Sheet | modal · side drawer · bottom sheet (mobile) | Focus-trapped, Esc to close, returns focus on close |
| Toast / Banner / Inline alert | info · success · warning · danger | Toast for transient, banner for persistent, inline for field |
| Tabs / Stepper | horizontal tabs · multi-step wizard | Keyboard arrow navigation; progress indication |
| Badge / Chip / Status pill | neutral · status-coloured · removable | Status colour from semantic tokens; text label always present |
| Command palette | global “go to / do” (Ctrl/Cmd-K) | Search across patients, screens, and actions |

Table 9.3 — Core component inventory and required states.

## 9.4 Application Shell & Navigation

Every authenticated screen renders inside one shell: a top bar (brand, global search/command palette, branch scope switcher, notifications, help, account), a left navigation rail, the primary work area, and an optional right context drawer that carries the active patient/encounter.

Figure 9.2 — Application shell: top bar, left navigation, primary work area, and context drawer.

- Branch scope switcher. Multi-branch users switch active branch from the top bar; the selection scopes data, defaults, and permissions across the session (per RBAC scoping).

- Role- and flag-gated navigation. Nav items render only when the user’s role permits and the tenant’s feature flag is enabled; disabled modules are hidden, and direct access shows an upgrade prompt rather than a dead end.

- Global search / command palette. Ctrl/Cmd-K opens a unified search across patients, appointments, invoices, and navigable actions.

The information architecture below shows the navigable structure beneath the shell.

Figure 9.3 — Information architecture / navigation map.

## 9.5 Information Architecture & Screen Inventory

Primary screens by module (secondary dialogs and drawers omitted). Flag-gated modules appear only when enabled for the tenant.

| Area | Primary screens |
| --- | --- |
| Dashboard | Role-aware landing with KPI cards and today’s work |
| Patients | List/search · Register (wizard) · Patient record (EMR, history, attachments) |
| Appointments | Calendar (day/week/month) · Book / reschedule · Cancellations & no-shows |
| Queue | Live department board · Check-in |
| Consultation | Encounter workspace · Prescription · Dynamic forms |
| Laboratory | Orders · Worklist · Result entry & validation |
| Pharmacy | Dispense · Drug catalog & batches · OTC sale |
| Inventory | Stock levels · Transfers · Purchasing |
| Billing | Invoices · Payments · Insurance claims |
| Reports | Operational & financial dashboards · Exports |
| Admin | Branches & departments · Users & roles · Settings, flags & branding |

Table 9.4 — Screen inventory.

## 9.6 Interaction Patterns

#### Forms & validation

- Labels are always visible (no placeholder-only fields); required fields are marked; helper text sits beneath the field.

- Validation is inline and on blur/submit; the first error is focused and summarised; field errors use the danger token plus an icon (never colour alone).

- Long forms use steppers with progress, save-as-draft, and resumable state; unsaved-change guards prevent accidental loss.

- Dynamic forms render from the versioned JSON schema (Section 6.6) using the same field components and validation affordances.

#### Data tables

- Sticky headers, server-side sort/filter/paginate, saved filters, column density toggle, and per-row and bulk actions; selection reveals a contextual action bar.

- Numbers right-aligned and tabular; status shown as coloured pills; row click opens detail in a drawer where possible to preserve list context.

#### Overlays & feedback

- Drawers for contextual detail/edit (keep the list visible); modals only for focused, blocking decisions; bottom sheets on mobile.

- Toasts confirm transient success and offer undo where feasible; banners carry persistent state (e.g., outstanding balance); inline alerts attach to the relevant field or section.

#### Every screen defines four states

- Loading (skeletons, not spinners, for content regions), empty (explainer + primary action), error (cause + retry), and populated — designed explicitly, never left to default.

## 9.7 Key Screens & Wireframes

### 9.7.1 Role-Aware Dashboards

The landing experience adapts to the signed-in role: the same shell surfaces the widgets each role needs first, reducing time-to-task.

Figure 9.4 — Role-aware dashboards (receptionist, doctor, lab technician, clinic admin).

### 9.7.2 Patient Registration

A short three-step wizard captures demographics, contact/insurance, and consents. Real-time duplicate detection warns before a record is created; inline validation prevents malformed data.

Figure 9.5 — Patient registration wizard with duplicate detection and inline validation.

### 9.7.3 Appointment Scheduling

A provider/resource day view with drag-to-create and drag-to-reschedule, colour-coded by provider and status, with day/week/month switching and quick booking.

Figure 9.6 — Appointment scheduling, provider day view.

### 9.7.4 Live Queue & Check-In

A column board (waiting → called → in consultation → completed) updates in real time; staff call, reassign, or mark no-show. Waiting time and priority are visible at a glance.

Figure 9.7 — Live queue board for a department.

### 9.7.5 Consultation & EMR

The clinical workspace keeps a persistent patient banner (with allergy alerts), a section rail for the encounter, a structured editor (SOAP, vitals, diagnoses, prescription), and a history timeline. Prescribing checks allergies and interactions, blocking unsafe orders. Notes auto-save and become immutable once signed.

Figure 9.8 — Consultation & EMR workspace with clinical-safety alerts and history timeline.

### 9.7.6 Billing & Payments

Charges accrued across the visit (consultation, pharmacy, lab) assemble into an invoice; staff record payments, apply discounts (with approval), and submit insurance claims. Balance and status are always explicit.

Figure 9.9 — Invoice with itemised charges, insurance, and payment actions.

## 9.8 Primary User Flow

The core visit journey threads the screens above into one continuous flow; events emitted along the way (Section 5.5) keep billing, notifications, and records in sync.

Figure 9.10 — Primary visit flow: register → book → check-in → consult → orders → results → billing.

## 9.9 Role-Based UI & Landing Experiences

| Role | Default landing | Emphasis |
| --- | --- | --- |
| Receptionist / Front desk | Check-in queue + today’s appointments | Register, book, check-in, collect payment |
| Doctor / Clinician | My schedule + patients waiting | Consultation, prescriptions, results review |
| Nurse | Vitals & queue | Triage, vitals capture, assisting workflows |
| Lab technician | Sample worklist | Accession, result entry, validation |
| Pharmacist | Dispense queue | Dispensing, batch/expiry, stock |
| Cashier / Billing | Unbilled visits & invoices | Invoicing, payments, claims |
| Clinic / Branch admin | Operational & financial overview | Utilisation, staff, plan usage |
| Patient (portal) | Upcoming visits & results | Self-booking, documents, balances |

Table 9.5 — Role-based landing experiences (full RBAC matrix in the PRD).

## 9.10 Responsive & Device Strategy

Desktop-first for staff workstations, fully responsive down to tablet for clinical capture and mobile for the patient portal and quick actions.

Figure 9.11 — Responsive strategy by device class.

| Breakpoint | Layout behaviour |
| --- | --- |
| ≤ 640px (mobile) | Single column; left nav becomes a drawer / bottom tab bar; tables collapse to cards; bottom sheets for actions |
| 641–1024px (tablet) | Two-pane; collapsible nav; touch targets ≥ 44px; optimised for vitals/queue capture |
| 1025–1440px (desktop) | Persistent sidebar + work area; context drawer on demand |
| > 1440px (wide) | Content max-width centred; context drawer can pin open; denser tables |

Table 9.6 — Breakpoints and layout behaviour.

## 9.11 Accessibility (WCAG 2.1 AA)

- Colour contrast meets AA (≥ 4.5:1 text, ≥ 3:1 large text and UI boundaries); status is conveyed by icon/text as well as colour.

- Full keyboard operability with a logical tab order, visible focus rings, skip-to-content, and no keyboard traps; shortcuts for high-frequency actions.

- Semantic HTML and ARIA: landmarks, labelled controls, described errors, and live regions announcing async updates (e.g., queue changes, save confirmations).

- Targets ≥ 44×44px on touch; forms support autofill and assistive tech; modals trap and restore focus.

- Respects prefers-reduced-motion and prefers-color-scheme; text resizes to 200% without loss of function.

## 9.12 Localization, Internationalization & RTL

- All copy is externalised for translation; no concatenated strings; pluralisation and gender handled via the i18n library.

- Locale-aware dates, numbers, and currency; timestamps shown in the branch/user timezone (stored UTC).

- Full RTL support: the layout mirrors (nav, alignment, icons) when an RTL locale is active; components are direction-agnostic.

- Layouts tolerate ~30–40% text expansion without truncation or overflow.

## 9.13 Theming & Multi-Tenant Branding

- Tenants configure a logo, primary/accent brand colours, and document letterhead from Admin; the app re-themes from tokens at runtime — no redeploy.

- Brand colours are validated for contrast; if a chosen colour fails AA against required surfaces, the UI substitutes an accessible shade and warns the admin.

- Light and dark themes share the same semantic token roles; printed/PDF documents (invoices, prescriptions, reports) inherit tenant branding.

## 9.14 Microcopy & Content Guidelines

- Plain, clinical-appropriate language; verbs for actions (“Sign & close”, “Record payment”); avoid jargon in patient-facing surfaces.

- Error messages state what happened and how to fix it, never blame the user; empty states explain value and offer the next action.

- Confirmations name the consequence (“Delete 3 draft invoices? This cannot be undone.”); destructive verbs are explicit.

- Sentence case for UI text; consistent terminology drawn from the project glossary (e.g., “encounter”, “branch”, “claim”).

## 9.15 Notifications & Feedback Patterns

| Channel | When | Pattern |
| --- | --- | --- |
| Toast | Transient outcome of a user action | Auto-dismiss; optional undo; bottom/top corner |
| Inline alert | Field- or section-level issue | Attached to the relevant control; persists until resolved |
| Banner | Persistent contextual state | e.g., outstanding balance, module disabled, system notice |
| In-app notification centre | Async events for the user | Bell with unread count; deep-links to the record |
| Email / SMS | External reminders & results | Appointment reminders, result-ready, receipts (per prefs) |

Table 9.7 — Feedback channels and when to use each.

## 9.16 Design-to-Development Handoff

- Single source of truth: tokens and components are defined once and consumed by both design (library) and code (Tailwind + ShadCN), keeping parity.

- Each component ships with documented props, all states, usage do/don’t, and accessibility notes; screens are specified with responsive behaviour and the four content states.

- Acceptance includes visual regression and accessibility checks in CI; deviations from tokens are flagged in review.