package service

import (
	"context"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// What a stay costs — the ONE definition, used by the board, by discharge and by the
// reports, so the estimate a nurse reads and the bill the patient pays cannot disagree.
//
// Two things were wrong before, both measured against the live system:
//
//   - Transfer overwrote the admission's daily_rate, so discharge billed every night of
//     the stay at whatever bed the patient ended in. Ten nights at 300 plus one at
//     3,000 billed 33,000 instead of 6,000. Money now comes from bed_admission_stays,
//     which records what was actually occupied and at what rate.
//
//   - "Days" was ceil(elapsed / 24h). A patient admitted at 08:00 and discharged at
//     09:00 the next morning — one night in the bed — was billed two days, and an
//     exactly-ten-day stay billed eleven, because ceil rounds any fraction up. No
//     hospital bills a rolling 24-hour clock from the admission minute; they bill
//     nights.
//
// A night is a midnight crossed **in Addis**, not in the session's UTC — the same
// day-boundary rule that has already bitten the Z-report, deposit ageing and the
// finance chart. The bed a patient is in at midnight is the bed billed for that night,
// which is both the hospital convention and what makes a mid-day transfer free.
//
// A patient admitted and discharged on the same day crosses no midnight and is billed
// one night at the rate of the first bed they occupied, which is the usual floor.
const addisTZ = "Africa/Addis_Ababa"

// stayBillSQL returns (admission_id, nights, amount) for the given admissions.
// `until` is what an open segment is measured to — now() for a live board, the
// discharge instant when settling.
const stayBillSQL = `
WITH seg AS (
    SELECT s.admission_id, s.daily_rate, s.from_at,
           coalesce(s.to_at, $3::timestamptz) AS to_at,
           row_number() OVER (PARTITION BY s.admission_id ORDER BY s.from_at) AS n
      FROM bed_admission_stays s
     WHERE s.tenant_id = $1 AND s.admission_id = ANY($2::uuid[])
), nights AS (
    SELECT admission_id, daily_rate, n,
           -- midnights crossed inside this segment, in the clinic's own day
           greatest(0, ((to_at   AT TIME ZONE '` + addisTZ + `')::date
                      - (from_at AT TIME ZONE '` + addisTZ + `')::date)) AS nights
      FROM seg
), total AS (
    SELECT admission_id, sum(nights) AS nights, sum(nights * daily_rate) AS amount,
           -- the first bed's rate, for the same-day floor
           min(n) AS first_n
      FROM nights GROUP BY admission_id
)
SELECT t.admission_id,
       CASE WHEN t.nights < 1 THEN 1 ELSE t.nights END,
       CASE WHEN t.nights < 1
            THEN (SELECT daily_rate FROM nights x WHERE x.admission_id = t.admission_id AND x.n = t.first_n)
            ELSE t.amount END
  FROM total t`

// StayCost is what one admission has run up.
type StayCost struct {
	Nights int
	Amount float64
}

// stayCosts prices a set of admissions in one query. Missing ids (an admission with no
// segments, which only legacy rows could be) come back absent, and callers fall back to
// zero rather than inventing a number.
func stayCosts(ctx context.Context, tx pgx.Tx, tid uuid.UUID, ids []uuid.UUID, untilSQL string) (map[uuid.UUID]StayCost, error) {
	out := map[uuid.UUID]StayCost{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, stayBillSQL, tid, ids, untilSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var nights int
		var amount float64
		if err := rows.Scan(&id, &nights, &amount); err != nil {
			return nil, err
		}
		out[id] = StayCost{Nights: nights, Amount: amount}
	}
	return out, rows.Err()
}

// What the stay has cost AND what has been paid against it — the second half of the
// same question, and for the same reason kept in one place.
//
// The board used to show "est. ETB 26,000" and stop there. A nurse could not tell a
// family what was still owed, the cashier had nothing to collect until discharge, and
// a thirty-day stay paid ten days at a time left no trace of how far the money reached.
//
// "Covered nights" is the walk that makes that legible: the nights of the stay in the
// order they were slept, each at the rate of the bed the patient was actually in, with
// the settled money spent against them until it runs out. A patient who paid 4,500 on
// a 450 bed is covered for ten nights; if they were moved to intensive care on night
// three, the same money covers fewer, which is the truth the family needs to hear.
//
// Waived money counts as covered but not as paid: nothing more will be collected for
// it, and saying it was "paid" would overstate what came through the till.
const stayMoneySQL = `
WITH seg AS (
    SELECT s.admission_id, s.daily_rate, s.from_at,
           coalesce(s.to_at, $3::timestamptz) AS to_at,
           row_number() OVER (PARTITION BY s.admission_id ORDER BY s.from_at) AS n
      FROM bed_admission_stays s
     WHERE s.tenant_id = $1 AND s.admission_id = ANY($2::uuid[])
), spans AS (
    SELECT admission_id, daily_rate, n,
           (from_at AT TIME ZONE '` + addisTZ + `')::date AS d0,
           (to_at   AT TIME ZONE '` + addisTZ + `')::date AS d1
      FROM seg
), counted AS (
    SELECT admission_id, sum(greatest(0, d1 - d0)) AS nights FROM spans GROUP BY admission_id
), per_night AS (
    -- every midnight the patient crossed, priced at the bed they were in that night
    SELECT s.admission_id, s.daily_rate,
           generate_series(s.d0, s.d1 - 1, interval '1 day')::date AS night
      FROM spans s
    UNION ALL
    -- a stay that has crossed no midnight is still one night, at the first bed's rate
    SELECT s.admission_id, s.daily_rate, s.d0
      FROM spans s JOIN counted c ON c.admission_id = s.admission_id
     WHERE c.nights < 1 AND s.n = 1
), last_bed AS (
    -- the bed they are in now: what a night paid for in advance would cost
    SELECT DISTINCT ON (admission_id) admission_id, daily_rate
      FROM spans ORDER BY admission_id, n DESC
), edge AS (
    SELECT admission_id, max(night) AS last_night FROM per_night GROUP BY admission_id
), future AS (
    -- Nights not yet slept. A family that books thirty days and pays for ten has
    -- covered ten, even on the first morning, and saying "1 of 30" because only one
    -- midnight has passed would understate what they handed over.
    SELECT e.admission_id, lb.daily_rate, (e.last_night + g)::date AS night
      FROM edge e
      JOIN last_bed lb ON lb.admission_id = e.admission_id
      CROSS JOIN generate_series(1, 400) g
     WHERE lb.daily_rate > 0
), all_nights AS (
    SELECT admission_id, daily_rate, night FROM per_night
    UNION ALL
    SELECT admission_id, daily_rate, night FROM future
), running AS (
    SELECT admission_id, night, daily_rate,
           sum(daily_rate) OVER (PARTITION BY admission_id ORDER BY night
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum
      FROM all_nights
), accrued AS (
    SELECT admission_id, count(*)::int AS nights, coalesce(sum(daily_rate),0) AS amount
      FROM per_night GROUP BY admission_id
), money AS (
    SELECT c.admission_id,
           coalesce(sum(c.amount) FILTER (WHERE c.status IN ('pending','paid','waived')),0) AS billed,
           coalesce(sum(c.amount) FILTER (WHERE c.status = 'paid'),0)                       AS paid,
           coalesce(sum(c.amount) FILTER (WHERE c.status IN ('paid','waived')),0)           AS settled
      FROM charges c
     WHERE c.tenant_id = $1 AND c.admission_id = ANY($2::uuid[]) AND c.deleted_at IS NULL
     GROUP BY c.admission_id
), covered AS (
    SELECT r.admission_id, count(*)::int AS nights, max(r.night) AS through
      FROM running r JOIN money m ON m.admission_id = r.admission_id
     WHERE r.cum <= m.settled
     GROUP BY r.admission_id
)
SELECT a.admission_id, a.nights, a.amount,
       coalesce(m.billed,0), coalesce(m.paid,0), coalesce(m.settled,0),
       coalesce(cv.nights,0), cv.through
  FROM accrued a
  LEFT JOIN money   m  ON m.admission_id  = a.admission_id
  LEFT JOIN covered cv ON cv.admission_id = a.admission_id`

// StayMoney is one admission's full money picture, live.
type StayMoney struct {
	Nights int     // nights slept so far (or the same-day floor of 1)
	Amount float64 // what those nights have cost
	Billed float64 // raised as charges and not voided
	Paid   float64 // money actually received
	// Accrued but never raised as a charge — what a top-up would ask for. The
	// cashier cannot collect what was never billed, which is the gap this closes.
	Unbilled float64
	// Still to come in: cost less money received and money forgiven.
	Outstanding   float64
	CoveredNights int
	CoveredThru   *time.Time
}

func stayMoney(ctx context.Context, tx pgx.Tx, tid uuid.UUID, ids []uuid.UUID, untilSQL string) (map[uuid.UUID]StayMoney, error) {
	out := map[uuid.UUID]StayMoney{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := tx.Query(ctx, stayMoneySQL, tid, ids, untilSQL)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var m StayMoney
		var settled float64
		var thru *time.Time
		if err := rows.Scan(&id, &m.Nights, &m.Amount, &m.Billed, &m.Paid, &settled,
			&m.CoveredNights, &thru); err != nil {
			return nil, err
		}
		m.Unbilled = round2(m.Amount - m.Billed)
		m.Outstanding = round2(m.Amount - settled)
		if m.Unbilled < 0 {
			m.Unbilled = 0 // billed ahead: a deposit larger than the stay so far
		}
		if m.Outstanding < 0 {
			m.Outstanding = 0
		}
		m.CoveredThru = thru
		out[id] = m
	}
	return out, rows.Err()
}

func round2(f float64) float64 { return math.Round(f*100) / 100 }
