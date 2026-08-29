package service

import (
	"context"

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
