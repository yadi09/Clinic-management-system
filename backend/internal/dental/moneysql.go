package dental

// SessionMoneySQL is the one place a treatment session's money is worked out.
//
// It lives in the ports package rather than the service because two modules need
// the same answer: dental itself, for balances and the cashier, and messaging,
// which has to know what a patient actually owes before it chases them for it.
// Copying it into the second caller is how the two would come to disagree — and
// the disagreement would surface as a patient being texted about a bill they had
// already paid.
//
// Takes $1 = tenant_id, and exposes the CTE `session_money` to whatever SELECT is
// appended to it.
const SessionMoneySQL = `
WITH session_charge AS (
  SELECT se.id AS session_id,
         se.tenant_id, se.plan_id, se.patient_id, se.seq,
         se.kind, se.service_item_id,
         se.scheduled_date, se.created_at,
         se.status AS session_status,
         se.pay_later,
         coalesce(se.pay_later_note,'') AS pay_later_note,
         coalesce(se.procedure,'')      AS procedure,
         coalesce(se.tooth,'')          AS tooth,
         se.amount_due,
         se.completed_at, se.completed_by, se.branch_id,
         c.id AS charge_id, c.status AS charge_status, c.amount AS charge_amount,
         rev.refunded_amount
  FROM treatment_sessions se
  LEFT JOIN charges c
         ON c.id = se.charge_id AND c.tenant_id = se.tenant_id AND c.deleted_at IS NULL
  LEFT JOIN LATERAL (
        SELECT sum(-r.amount) AS refunded_amount
        FROM charges r
        WHERE r.tenant_id = c.tenant_id AND r.reverses_charge_id = c.id AND r.deleted_at IS NULL
  ) rev ON true
  WHERE se.tenant_id = $1
),
session_money AS (
  SELECT sc.*,
         -- Money the clinic is entitled to ask for now.
         --
         -- For a visit that means the treatment actually happened. pay_later alone
         -- does NOT count: before the billing gate was removed it was the mechanism
         -- for unlocking the record form, so promises exist on sessions that were
         -- never delivered, and billing those charges for treatment nobody had.
         --
         -- A down payment is the exception, and it is not a special case bolted on:
         -- a deposit is owed the moment the course is agreed — that is what makes it
         -- a deposit. It is never marked done because there is nothing clinical to
         -- deliver, so a rule that says "done or nothing" silently excused every
         -- unpaid deposit in the clinic from the unbilled report, the "Owes" badge
         -- and the patient's due balance, while the plan card said it was owed.
         (sc.session_status = 'done' OR sc.kind = 'deposit') AS owed_now,
         -- A deposit cannot be a broken promise about a visit that never happened.
         (sc.pay_later AND sc.session_status <> 'done' AND sc.kind <> 'deposit') AS promised_undelivered,
         -- When the debt started running: treatment date for a visit, the day the
         -- course was agreed for a deposit. A deposit dated to the plan's START would
         -- age from a day that can be in the future, which reads as a negative age on
         -- the report and held back its reminder until the course began.
         CASE WHEN sc.kind = 'deposit' THEN sc.created_at
              ELSE coalesce(sc.completed_at, sc.scheduled_date::timestamptz) END AS owed_since,
         CASE
           WHEN sc.charge_id IS NULL           THEN 'unpaid'
           WHEN sc.charge_status = 'void'      THEN 'unpaid'
           WHEN sc.charge_status = 'pending'   THEN 'billed'
           WHEN sc.charge_status = 'waived'    THEN 'waived'
           WHEN sc.refunded_amount IS NOT NULL THEN 'refunded'
           ELSE 'paid'
         END AS pay_state,
         CASE WHEN sc.charge_status = 'paid'
              THEN sc.charge_amount - coalesce(sc.refunded_amount, 0)
              ELSE 0 END AS net_paid,
         CASE WHEN sc.charge_status = 'paid' AND sc.refunded_amount IS NOT NULL
              THEN sc.refunded_amount
              ELSE sc.amount_due END AS owed_amount
  FROM session_charge sc
)`
