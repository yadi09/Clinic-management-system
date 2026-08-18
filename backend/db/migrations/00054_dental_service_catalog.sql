-- +goose Up
-- +goose StatementBegin
-- One price list, extended to cover dental work.
--
-- A dental treatment plan carried a free-typed title and a free-typed total, so the
-- same procedure was priced differently every time it was sold. In the live data
-- one clinic's root canal exists three times over — "Root canel" at 50,000,
-- "Root Canal" at 45,000, and "rct" at 0 — and because the Services report groups
-- by that text, those are three products. The clinic cannot answer "how many root
-- canals did we do, and for how much".
--
-- The fix is the catalog the clinic already has, not a second one beside it:
-- charges already carry service_item_id and the finance report already prefers the
-- catalog name over free text, so linking dental work to a service item makes the
-- reporting correct with no reporting change at all. Two price lists would be the
-- same disease with extra steps.

-- Who may put this service on a patient. Registration is a front-desk act; a root
-- canal is not. Per-service rather than a role rule, because a five-person clinic
-- and a forty-person clinic draw that line in different places and both are right.
ALTER TABLE service_items
  ADD COLUMN assignable_by TEXT NOT NULL DEFAULT 'either'
    CHECK (assignable_by IN ('reception', 'clinician', 'either'));

COMMENT ON COLUMN service_items.assignable_by IS
  'reception = front desk only, clinician = clinical staff only, either = both. Enforced wherever a charge is raised.';
COMMENT ON COLUMN service_items.category IS
  'general | dental. Scopes the catalog page and decides which staff may create entries in it.';

-- What the plan was sold as, and what it was sold FOR.
--
-- list_price is snapshotted rather than read through the link: a catalog price rise
-- next year must not retroactively turn last year's full-price course into a
-- discount. The difference between list_price and total_amount IS the discount, and
-- it is only meaningful if the list price is the one that was on the screen.
ALTER TABLE treatment_plans
  ADD COLUMN service_item_id UUID REFERENCES service_items(id),
  ADD COLUMN list_price NUMERIC(12,2);

CREATE INDEX idx_treatment_plans_service ON treatment_plans(tenant_id, service_item_id)
  WHERE service_item_id IS NOT NULL;

-- An extra done at one visit: an X-ray taken mid-course, a scaling that was not in
-- the plan. Priced from the catalog, and a price of 0 means "included in the
-- course" — which makes that an explicit decision at the chair rather than an
-- argument about what the course covers.
--
-- It is a treatment_sessions row, NOT a new table. The whole money projection —
-- balance, receivables, the cashier, refunds, write-offs, every finance tab — is
-- built on that one query, exactly as the deposit was. A separate extras table
-- would mean teaching six money surfaces about a new lane, and the one that got
-- missed would quietly lose money.
ALTER TABLE treatment_sessions
  ADD COLUMN service_item_id UUID REFERENCES service_items(id),
  ADD COLUMN parent_session_id UUID REFERENCES treatment_sessions(id) ON DELETE CASCADE;

ALTER TABLE treatment_sessions DROP CONSTRAINT IF EXISTS treatment_sessions_kind_check;
ALTER TABLE treatment_sessions
  ADD CONSTRAINT treatment_sessions_kind_check CHECK (kind IN ('visit', 'deposit', 'extra'));

CREATE INDEX idx_treatment_sessions_extra ON treatment_sessions(tenant_id, parent_session_id)
  WHERE kind = 'extra';

COMMENT ON COLUMN treatment_sessions.parent_session_id IS
  'The visit an extra was performed at. NULL for visits and deposits.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DELETE FROM treatment_sessions WHERE kind = 'extra';
ALTER TABLE treatment_sessions DROP CONSTRAINT IF EXISTS treatment_sessions_kind_check;
ALTER TABLE treatment_sessions
  ADD CONSTRAINT treatment_sessions_kind_check CHECK (kind IN ('visit', 'deposit'));
DROP INDEX IF EXISTS idx_treatment_sessions_extra;
ALTER TABLE treatment_sessions
  DROP COLUMN IF EXISTS service_item_id,
  DROP COLUMN IF EXISTS parent_session_id;
DROP INDEX IF EXISTS idx_treatment_plans_service;
ALTER TABLE treatment_plans
  DROP COLUMN IF EXISTS service_item_id,
  DROP COLUMN IF EXISTS list_price;
ALTER TABLE service_items DROP COLUMN IF EXISTS assignable_by;
-- +goose StatementEnd
