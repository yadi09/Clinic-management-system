// Package produce holds the workers that write notifications. Each producer turns
// one kind of event into rows in the notifications table; the inbox reads them.
package produce

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/notification"
)

// MissedVisitRoles are the staff told about every missed visit in their clinic,
// alongside the dentist who planned the course.
var MissedVisitRoles = []string{"tenant_owner", "clinic_admin", "receptionist"}

// lookbackDays bounds how far back a pass looks. The watermark already stops the
// first run from reaching into the clinic's history; this keeps every later pass
// cheap and lets a worker that was down over a weekend still catch up.
const lookbackDays = 14

// MissedVisits notifies staff when a dental course visit was missed.
//
// "Missed" is the rule the dental screens already use (DeskActions,
// TreatmentsPanel): a visit still planned, in an active course, whose date is
// before today in the clinic's own timezone. Nothing here invents a new meaning.
// A visit that is rebooked before the pass runs is no longer missed and is never
// notified; one rebooked and missed again on its new date is a new miss.
type MissedVisits struct {
	db  *kerneldb.DB // privileged: reads and writes across every clinic
	log *slog.Logger
}

// NewMissedVisits builds the producer over the privileged pool.
func NewMissedVisits(db *kerneldb.DB, log *slog.Logger) *MissedVisits {
	return &MissedVisits{db: db, log: log}
}

// Run produces and clears on an interval until the context is cancelled.
func (m *MissedVisits) Run(ctx context.Context, interval time.Duration) {
	run(ctx, m, "missed-visit", interval, m.log)
}

// Produce writes one notification per missed visit per recipient, and returns how
// many were new (or, once, filled in with the fields added in 00088). It is safe to run any number of times: the unique dedupe index
// refuses a second copy, so nothing here checks first.
func (m *MissedVisits) Produce(ctx context.Context) (int, error) {
	var created int64
	err := m.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx, missedVisitSQL, MissedVisitRoles, lookbackDays, notification.KindMissedVisit)
		created = ct.RowsAffected()
		return e
	})
	return int(created), err
}

// Resolve marks as read every unread missed-visit notification whose visit is no
// longer that miss: rebooked to another date, done, cancelled, its course ended,
// or the patient removed. A missed-visit notice is a task ("rebook this patient"),
// and an unread count that still shows handled tasks teaches staff to ignore the
// badge. The notice stays in the list as history; only its unread state goes.
func (m *MissedVisits) Resolve(ctx context.Context) (int, error) {
	var cleared int64
	err := m.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx, resolveMissedVisitSQL, notification.KindMissedVisit)
		cleared = ct.RowsAffected()
		return e
	})
	return int(cleared), err
}

// resolveMissedVisitSQL: a notice still stands only while its visit is the exact
// miss it was raised for, identified by the same key the producer wrote (visit +
// date). Anything else, including a visit that no longer exists, clears it.
const resolveMissedVisitSQL = `
UPDATE notifications n SET read_at = now()
 WHERE n.kind = $1 AND n.read_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM treatment_sessions se
           JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
           JOIN patients pt ON pt.id = se.patient_id AND pt.tenant_id = se.tenant_id
                           AND pt.deleted_at IS NULL
          WHERE se.id = n.subject_id AND se.tenant_id = n.tenant_id
            AND se.kind = 'visit' AND se.status = 'planned' AND pl.status = 'active'
            AND n.dedupe_key = $1 || ':' || se.id::text || ':' || se.scheduled_date::text)`

// missedVisitSQL finds missed visits, chooses who hears about each one, and writes
// the notifications, in one statement.
//
// Recipients: the owner, clinic administrators and reception, plus the user who
// planned the course. If that user is gone or inactive, the clinic's doctors are
// told instead, so a missed visit always reaches someone clinical.
//
// Branches: a planned visit records no branch yet (branch_id is stamped when the
// visit is done), so today every recipient in the clinic is told, whatever branch
// their role is limited to. The branch test below takes effect once a planned visit
// carries its branch.
//
// One clinic must not stop the others: an unknown timezone falls back to Addis
// rather than failing the whole statement, and a clinic with no clinics row uses
// its tenant's timezone.
//
// $1 role codes · $2 lookback days · $3 notification kind.
const missedVisitSQL = `
WITH zones AS MATERIALIZED (
  -- Read once per pass: the catalogue is ~125ms to scan, and checked per row it
  -- turned a sub-second pass into seconds.
  SELECT name FROM pg_timezone_names
),
missed AS (
  SELECT se.tenant_id, se.id AS session_id, se.patient_id, se.seq, se.scheduled_date,
         se.branch_id, pl.title, pl.created_by,
         coalesce(nullif(btrim(concat_ws(' ', nullif(btrim(pt.first_name), ''),
                                              nullif(btrim(pt.last_name), ''))), ''),
                  'A patient') AS patient_name,
         pt.mrn
    FROM treatment_sessions se
    JOIN treatment_plans pl ON pl.id = se.plan_id AND pl.tenant_id = se.tenant_id
    JOIN patients pt ON pt.id = se.patient_id AND pt.tenant_id = se.tenant_id
                    AND pt.deleted_at IS NULL
    JOIN tenants tn ON tn.id = se.tenant_id AND tn.deleted_at IS NULL
                   AND tn.status NOT IN ('suspended', 'cancelled')
    LEFT JOIN LATERAL (
          SELECT c2.timezone FROM clinics c2
           WHERE c2.tenant_id = se.tenant_id AND c2.deleted_at IS NULL
           ORDER BY c2.created_at LIMIT 1
         ) cl ON true
    CROSS JOIN LATERAL (
          SELECT CASE WHEN EXISTS (SELECT 1 FROM zones z
                                    WHERE z.name = coalesce(cl.timezone, tn.timezone))
                      THEN coalesce(cl.timezone, tn.timezone)
                      ELSE 'Africa/Addis_Ababa' END AS timezone
         ) c
    JOIN notification_watermarks w ON w.kind = $3
   WHERE se.kind = 'visit'
     AND se.status = 'planned'
     AND pl.status = 'active'
     AND se.scheduled_date <  (now() AT TIME ZONE c.timezone)::date
     AND se.scheduled_date >= w.since
     AND se.scheduled_date >= (now() AT TIME ZONE c.timezone)::date - $2::int
),
recipients AS (
  SELECT DISTINCT m.*, u.id AS user_id
    FROM missed m
    JOIN users u ON u.tenant_id = m.tenant_id AND u.status = 'active' AND u.deleted_at IS NULL
   WHERE u.id = m.created_by
      OR EXISTS (
           SELECT 1 FROM user_role_scopes urs JOIN roles r ON r.id = urs.role_id
            WHERE urs.user_id = u.id AND urs.tenant_id = m.tenant_id
              AND r.code = ANY($1::text[])
              AND (urs.branch_id IS NULL OR m.branch_id IS NULL OR urs.branch_id = m.branch_id))
      OR (NOT EXISTS (
             SELECT 1 FROM users cu
              WHERE cu.id = m.created_by AND cu.tenant_id = m.tenant_id
                AND cu.status = 'active' AND cu.deleted_at IS NULL)
          AND EXISTS (
             SELECT 1 FROM user_role_scopes urs JOIN roles r ON r.id = urs.role_id
              WHERE urs.user_id = u.id AND urs.tenant_id = m.tenant_id AND r.code = 'doctor'
                AND (urs.branch_id IS NULL OR m.branch_id IS NULL OR urs.branch_id = m.branch_id)))
)
INSERT INTO notifications (tenant_id, user_id, kind, title, body, patient_id, subject_id, dedupe_key, data)
SELECT tenant_id, user_id, $3, 'Missed visit',
       -- "Visit 3", as the dental screens say it. No "of 6": a course's count
       -- changes as visits are cancelled or added, and a wrong total misleads.
       format('%s (card %s) missed visit %s of %s on %s.',
              patient_name, mrn, seq, title, to_char(scheduled_date, 'FMDD Mon YYYY')),
       patient_id, session_id,
       $3 || ':' || session_id::text || ':' || scheduled_date::text,
       -- The same facts as fields, for the screen to lay out.
       jsonb_build_object('patient', patient_name, 'card', mrn, 'course', title,
                          'visit', seq, 'date', scheduled_date::text)
  FROM recipients
-- A notice written before these fields existed gets them filled in once; a
-- complete one is left exactly as it is.
ON CONFLICT (tenant_id, user_id, dedupe_key)
DO UPDATE SET data = EXCLUDED.data WHERE notifications.data = '{}'::jsonb`
