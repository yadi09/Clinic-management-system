-- +goose Up
-- +goose StatementBegin

-- One-time repair for audit D14. Adding or removing an extra and editing a fee
-- never recomputed treatment_plans.total_amount, so courses drifted (6 of 14 on
-- the cure-dental test account, 14,000 ETB in all, measured 2026-09-30). The code
-- now recomputes on every change; this brings existing rows to the same rule: a
-- course's total is the sum of its lines that are not cancelled — visits, the
-- down payment and extras.
--
-- Only the displayed total changes. Balances, bills and payments are computed from
-- the lines themselves and are not touched.
UPDATE treatment_plans p
   SET total_amount = s.total, updated_at = now()
  FROM (SELECT plan_id, tenant_id, coalesce(sum(amount_due) FILTER (WHERE status <> 'cancelled'), 0) AS total
          FROM treatment_sessions GROUP BY plan_id, tenant_id) s
 WHERE s.plan_id = p.id AND s.tenant_id = p.tenant_id AND p.total_amount <> s.total;

-- +goose StatementEnd

-- +goose Down
-- The old totals were wrong and are not kept; nothing to restore.
SELECT 1;
