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

// PatientWaiting tells a doctor that a patient is in their queue, waiting.
//
// It reads the queue itself rather than listening for check-in. A patient reaches
// a doctor's queue several ways: an appointment check-in, a walk-in, after paying
// the intake fee, after triage, or by being reassigned. Only some of those send an
// event, and "checked in" can still mean "gone to pay first". The queue entry
// waiting with a doctor is the one fact that is true however they got there, and
// reading it leaves every one of those paths untouched.
//
// One notice per queue entry per doctor: reassigning a patient tells the new
// doctor, and the old doctor's notice clears.
type PatientWaiting struct {
	db  *kerneldb.DB // privileged: reads and writes across every clinic
	log *slog.Logger
}

// NewPatientWaiting builds the producer over the privileged pool.
func NewPatientWaiting(db *kerneldb.DB, log *slog.Logger) *PatientWaiting {
	return &PatientWaiting{db: db, log: log}
}

// Run produces and clears on an interval until the context is cancelled.
func (p *PatientWaiting) Run(ctx context.Context, interval time.Duration) {
	run(ctx, p, "patient-waiting", interval, p.log)
}

// waitingWindow is how long a waiting entry counts. A patient left "waiting" in a
// queue that nobody closed (the audit found dozens from earlier days) is not
// waiting for anyone, and must neither be announced nor stay unread.
const waitingWindow = "12 hours"

// Produce writes one notice per waiting patient per assigned doctor.
func (p *PatientWaiting) Produce(ctx context.Context) (int, error) {
	var created int64
	err := p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx, patientWaitingSQL, notification.KindPatientWaiting)
		created = ct.RowsAffected()
		return e
	})
	return int(created), err
}

// Resolve clears a notice once its patient is no longer waiting for that doctor:
// called, being seen, done, marked a no-show, removed, reassigned to someone
// else, or older than the waiting window.
func (p *PatientWaiting) Resolve(ctx context.Context) (int, error) {
	var cleared int64
	err := p.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx, resolvePatientWaitingSQL, notification.KindPatientWaiting)
		cleared = ct.RowsAffected()
		return e
	})
	return int(cleared), err
}

// patientWaitingSQL: $1 notification kind.
//
// Only the assigned doctor is told. A clinic's reception assigns the doctor at
// check-in; the queue's unassigned "pick up" pool is rare (one entry seen in
// production) and is left out on the owner's call. The screen to open is chosen
// here, by clinic type: a dentist starts from Chairside, a doctor from My day.
const patientWaitingSQL = `
WITH waiting AS (
  SELECT q.tenant_id, q.id AS queue_id, q.patient_id, q.assigned_provider_id AS user_id,
         coalesce(nullif(btrim(concat_ws(' ', nullif(btrim(pt.first_name), ''),
                                              nullif(btrim(pt.last_name), ''))), ''),
                  'A patient') AS patient_name,
         pt.mrn, coalesce(d.name, '') AS department, tn.clinic_type
    FROM queue_entries q
    JOIN patients pt ON pt.id = q.patient_id AND pt.tenant_id = q.tenant_id AND pt.deleted_at IS NULL
    JOIN tenants tn ON tn.id = q.tenant_id AND tn.deleted_at IS NULL
                   AND tn.status NOT IN ('suspended', 'cancelled')
    JOIN users u ON u.id = q.assigned_provider_id AND u.tenant_id = q.tenant_id
                AND u.status = 'active' AND u.deleted_at IS NULL
    LEFT JOIN departments d ON d.id = q.department_id AND d.tenant_id = q.tenant_id
    JOIN notification_watermarks w ON w.kind = $1
   WHERE q.state = 'waiting' AND q.deleted_at IS NULL
     AND q.stage = 'with_doctor'
     AND q.enqueued_at >= now() - interval '` + waitingWindow + `'
     AND q.enqueued_at >= w.since
)
INSERT INTO notifications (tenant_id, user_id, kind, title, body, patient_id, subject_id, dedupe_key, data)
SELECT tenant_id, user_id, $1, 'Patient waiting',
       format('%s (card %s) is waiting for you.', patient_name, mrn),
       patient_id, queue_id,
       $1 || ':' || queue_id::text || ':' || user_id::text,
       jsonb_build_object('patient', patient_name, 'card', mrn, 'department', department,
                          'screen', CASE WHEN clinic_type = 'dental' THEN 'chairside' ELSE 'worklist' END)
  FROM waiting
ON CONFLICT (tenant_id, user_id, dedupe_key) DO NOTHING`

const resolvePatientWaitingSQL = `
UPDATE notifications n SET read_at = now()
 WHERE n.kind = $1 AND n.read_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM queue_entries q
          WHERE q.id = n.subject_id AND q.tenant_id = n.tenant_id AND q.deleted_at IS NULL
            AND q.state = 'waiting' AND q.stage = 'with_doctor'
            AND q.assigned_provider_id = n.user_id
            AND q.enqueued_at >= now() - interval '` + waitingWindow + `')`
