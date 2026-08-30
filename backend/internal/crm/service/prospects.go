package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/crm"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

func decodePhase(s string) (uuid.UUID, error) { return id.Decode(id.PrefixCrmPhase, s) }

// prospectCols keeps every prospect query returning the same shape, so the list, the
// board and the single record cannot disagree about where a clinic stands.
const prospectCols = `
	p.id, p.clinic_name, coalesce(p.contact_name,''), coalesce(p.contact_role,''),
	coalesce(p.phone,''), coalesce(p.phone_alt,''), coalesce(p.email,''),
	coalesce(p.address,''), coalesce(p.map_url,''), coalesce(p.note,''),
	p.source, p.status, p.priority, coalesce(p.next_action,''),
	to_char(p.next_action_at,'YYYY-MM-DD'),
	to_char(p.ready_on,'YYYY-MM-DD'), coalesce(p.outcome_note,''),
	p.owner_id, coalesce(o.full_name, o.email, ''),
	e.id, e.campaign_id, coalesce(c.name,''), e.phase_id, coalesce(ph.name,''),
	coalesce(ph.seq,0), coalesce(pc.n,0),
	t.happened_at, coalesce(t.kind,''), coalesce(tb.full_name, tb.email, ''),
	coalesce(tc.n,0), p.created_at,
	CASE WHEN t.happened_at IS NULL THEN -1
	     ELSE (current_date - (t.happened_at AT TIME ZONE 'Africa/Addis_Ababa')::date) END`

const prospectFrom = `
	FROM crm_prospects p
	LEFT JOIN platform_admins o ON o.id = p.owner_id
	LEFT JOIN crm_enrollments e ON e.prospect_id = p.id AND e.status = 'active'
	LEFT JOIN crm_campaigns   c ON c.id = e.campaign_id
	LEFT JOIN crm_phases     ph ON ph.id = e.phase_id
	LEFT JOIN LATERAL (SELECT count(*) AS n FROM crm_phases x WHERE x.campaign_id = e.campaign_id) pc ON true
	LEFT JOIN LATERAL (
		SELECT h.kind, h.happened_at, h.by_id FROM crm_touches h
		 WHERE h.prospect_id = p.id ORDER BY h.happened_at DESC LIMIT 1
	) t ON true
	LEFT JOIN platform_admins tb ON tb.id = t.by_id
	LEFT JOIN LATERAL (SELECT count(*) AS n FROM crm_touches h2 WHERE h2.prospect_id = p.id) tc ON true`

func scanProspect(rows pgx.Rows) (crm.Prospect, error) {
	var p crm.Prospect
	err := rows.Scan(&p.ID, &p.ClinicName, &p.ContactName, &p.ContactRole,
		&p.Phone, &p.PhoneAlt, &p.Email, &p.Address, &p.MapURL, &p.Note,
		&p.Source, &p.Status, &p.Priority, &p.NextAction, &p.NextActionAt, &p.ReadyOn, &p.OutcomeNote,
		&p.OwnerID, &p.OwnerName,
		&p.EnrollmentID, &p.CampaignID, &p.CampaignName, &p.PhaseID, &p.PhaseName,
		&p.PhaseSeq, &p.PhaseCount,
		&p.LastTouchAt, &p.LastTouchKind, &p.LastTouchBy, &p.Touches, &p.CreatedAt, &p.SilentDays)
	return p, err
}

func (s *Service) ListProspects(ctx context.Context, f crm.Filter) ([]crm.Prospect, error) {
	var ownerID *uuid.UUID
	if f.Owner != "" && f.Owner != "all" {
		u, err := id.Decode(id.PrefixUser, f.Owner)
		if err != nil {
			return nil, apperr.Validation("unknown owner")
		}
		ownerID = &u
	}
	// The default order IS the advice: whatever is hottest and has been ignored
	// longest comes first. A list sorted by when it was typed in tells a rep
	// nothing about what to do next.
	rows, err := s.db.Pool.Query(ctx, `SELECT `+prospectCols+prospectFrom+`
		 WHERE p.deleted_at IS NULL
		   AND ($1 = '' OR p.clinic_name ILIKE '%'||$1||'%' OR coalesce(p.phone,'') ILIKE '%'||$1||'%'
		        OR coalesce(p.contact_name,'') ILIKE '%'||$1||'%' OR coalesce(p.address,'') ILIKE '%'||$1||'%')
		   AND ($2 = '' OR p.status = $2)
		   AND ($3::uuid IS NULL OR p.owner_id = $3)
		   AND ($4 = '' OR p.priority = $4)
		   AND ($5 = '' OR `+flagSQL+`)
		 ORDER BY (p.status = 'open') DESC,
		          CASE p.priority WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,
		          (p.next_action_at IS NOT NULL AND p.next_action_at <= current_date) DESC,
		          t.happened_at ASC NULLS FIRST,
		          p.created_at DESC
		 LIMIT 500`,
		strings.TrimSpace(f.Q), strings.TrimSpace(f.Status), ownerID,
		strings.TrimSpace(f.Priority), strings.TrimSpace(f.Flag))
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []crm.Prospect{}
	for rows.Next() {
		p, e := scanProspect(rows)
		if e != nil {
			return nil, apperr.Internal(e)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// flagSQL answers the questions a rep actually asks of the list. $5 is the flag.
const flagSQL = `
	CASE $5
	  WHEN 'never'   THEN t.happened_at IS NULL
	  WHEN 'overdue' THEN p.next_action_at IS NOT NULL AND p.next_action_at < current_date
	  WHEN 'due'     THEN p.next_action_at = current_date
	  WHEN 'chase'   THEN p.status = 'not_yet' AND p.ready_on IS NOT NULL AND p.ready_on <= current_date
	  WHEN 'silent'  THEN p.status = 'open' AND (t.happened_at IS NULL OR t.happened_at < now() - interval '14 days')
	  ELSE true
	END`

// Worklist is one person's morning.
//
// Every row carries the reason it is here, so the screen can group by "why" rather
// than making the rep work it out: a promise whose day has come, a step that has
// slipped, a hot clinic nobody has phoned, one going quiet. Ordered by how much it
// costs to leave it another day.
func (s *Service) Worklist(ctx context.Context, owner string) ([]crm.Prospect, error) {
	var ownerID *uuid.UUID
	if owner != "" && owner != "all" {
		u, err := id.Decode(id.PrefixUser, owner)
		if err != nil {
			return nil, apperr.Validation("unknown owner")
		}
		ownerID = &u
	}
	const reason = `
		CASE
		  WHEN p.status = 'not_yet' AND p.ready_on IS NOT NULL AND p.ready_on <= current_date THEN 'promised'
		  WHEN p.status <> 'open' THEN NULL
		  WHEN p.next_action_at IS NOT NULL AND p.next_action_at <  current_date THEN 'overdue'
		  WHEN p.next_action_at IS NOT NULL AND p.next_action_at =  current_date THEN 'today'
		  WHEN t.happened_at IS NULL AND p.priority = 'hot' THEN 'hot_untouched'
		  WHEN t.happened_at IS NULL AND p.created_at < now() - interval '3 days' THEN 'never'
		  WHEN t.happened_at < now() - interval '14 days' THEN 'silent'
		END`
	rows, err := s.db.Pool.Query(ctx, `SELECT `+prospectCols+`, `+reason+prospectFrom+`
		 WHERE p.deleted_at IS NULL AND ($1::uuid IS NULL OR p.owner_id = $1)
		   AND (`+reason+`) IS NOT NULL
		 ORDER BY CASE (`+reason+`)
		            WHEN 'promised' THEN 0 WHEN 'overdue' THEN 1 WHEN 'today' THEN 2
		            WHEN 'hot_untouched' THEN 3 WHEN 'never' THEN 4 ELSE 5 END,
		          CASE p.priority WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,
		          t.happened_at ASC NULLS FIRST
		 LIMIT 300`, ownerID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []crm.Prospect{}
	for rows.Next() {
		var p crm.Prospect
		var reasonV *string
		e := rows.Scan(&p.ID, &p.ClinicName, &p.ContactName, &p.ContactRole,
			&p.Phone, &p.PhoneAlt, &p.Email, &p.Address, &p.MapURL, &p.Note,
			&p.Source, &p.Status, &p.Priority, &p.NextAction, &p.NextActionAt, &p.ReadyOn, &p.OutcomeNote,
			&p.OwnerID, &p.OwnerName,
			&p.EnrollmentID, &p.CampaignID, &p.CampaignName, &p.PhaseID, &p.PhaseName,
			&p.PhaseSeq, &p.PhaseCount,
			&p.LastTouchAt, &p.LastTouchKind, &p.LastTouchBy, &p.Touches, &p.CreatedAt, &p.SilentDays,
			&reasonV)
		if e != nil {
			return nil, apperr.Internal(e)
		}
		p.Reason = deref(reasonV)
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetPriority is one click on a card: this one matters more than the others.
func (s *Service) SetPriority(ctx context.Context, pid uuid.UUID, priority string) error {
	switch priority {
	case "hot", "warm", "cold":
	default:
		return apperr.Validation("priority is hot, warm or cold")
	}
	if _, err := s.db.Pool.Exec(ctx,
		`UPDATE crm_prospects SET priority=$2, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`,
		pid, priority); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// SetNextAction records what happens next and when. An empty date clears it, which
// is how a rep says "nothing planned" without inventing a day.
func (s *Service) SetNextAction(ctx context.Context, pid uuid.UUID, note, on string) error {
	on = strings.TrimSpace(on)
	if on != "" {
		if _, e := time.Parse("2006-01-02", on); e != nil {
			return apperr.Validation("that is not a real date")
		}
	}
	if _, err := s.db.Pool.Exec(ctx,
		`UPDATE crm_prospects SET next_action=$2, next_action_at=$3, updated_at=now()
		  WHERE id=$1 AND deleted_at IS NULL`, pid, nz(note), nz(on)); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) GetProspect(ctx context.Context, pid uuid.UUID) (*crm.Prospect, []crm.Touch, []crm.Step, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT `+prospectCols+prospectFrom+` WHERE p.id = $1 AND p.deleted_at IS NULL`, pid)
	if err != nil {
		return nil, nil, nil, apperr.Internal(err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, nil, nil, apperr.NotFound("PROSPECT_NOT_FOUND", "that clinic is not in the pipeline")
	}
	p, e := scanProspect(rows)
	if e != nil {
		return nil, nil, nil, apperr.Internal(e)
	}
	rows.Close()

	touches := []crm.Touch{}
	trows, err := s.db.Pool.Query(ctx, `
		SELECT h.id, h.kind, coalesce(h.note,''), h.happened_at, coalesce(a.full_name, a.email, '')
		  FROM crm_touches h LEFT JOIN platform_admins a ON a.id = h.by_id
		 WHERE h.prospect_id = $1 ORDER BY h.happened_at DESC LIMIT 100`, pid)
	if err != nil {
		return nil, nil, nil, apperr.Internal(err)
	}
	for trows.Next() {
		var t crm.Touch
		if e := trows.Scan(&t.ID, &t.Kind, &t.Note, &t.HappenedAt, &t.ByName); e != nil {
			trows.Close()
			return nil, nil, nil, apperr.Internal(e)
		}
		touches = append(touches, t)
	}
	trows.Close()

	steps := []crm.Step{}
	srows, err := s.db.Pool.Query(ctx, `
		SELECT ph.name, ph.seq, coalesce(v.note,''), coalesce(a.full_name, a.email, ''), v.done_at
		  FROM crm_phase_events v
		  JOIN crm_enrollments en ON en.id = v.enrollment_id
		  JOIN crm_phases ph ON ph.id = v.phase_id
		  LEFT JOIN platform_admins a ON a.id = v.done_by
		 WHERE en.prospect_id = $1 ORDER BY v.done_at`, pid)
	if err != nil {
		return nil, nil, nil, apperr.Internal(err)
	}
	defer srows.Close()
	for srows.Next() {
		var st crm.Step
		if e := srows.Scan(&st.PhaseName, &st.Seq, &st.Note, &st.DoneBy, &st.DoneAt); e != nil {
			return nil, nil, nil, apperr.Internal(e)
		}
		steps = append(steps, st)
	}
	return &p, touches, steps, srows.Err()
}

// CheckDuplicates finds clinics that look like the one being added.
//
// Reps work the same neighbourhoods and the same clinic gets collected twice. The
// phone number is the strongest signal — two people reading the same signboard write
// the name differently but copy the same digits.
func (s *Service) CheckDuplicates(ctx context.Context, name, phone string) ([]crm.Duplicate, error) {
	name, phone = strings.TrimSpace(name), digitsOnly(phone)
	out := []crm.Duplicate{}
	if name == "" && phone == "" {
		return out, nil
	}
	rows, err := s.db.Pool.Query(ctx, `
		SELECT p.id, p.clinic_name, coalesce(p.phone,''), coalesce(o.full_name, o.email, ''), p.status,
		       CASE WHEN $2 <> '' AND regexp_replace(coalesce(p.phone,''), '\D', '', 'g') = $2
		            THEN 'same phone number' ELSE 'a very similar name' END AS why
		  FROM crm_prospects p
		  LEFT JOIN platform_admins o ON o.id = p.owner_id
		 WHERE p.deleted_at IS NULL
		   AND (($2 <> '' AND regexp_replace(coalesce(p.phone,''), '\D', '', 'g') = $2)
		     OR ($1 <> '' AND p.clinic_name ILIKE $1))
		 LIMIT 5`, name, phone)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var d crm.Duplicate
		if e := rows.Scan(&d.ID, &d.ClinicName, &d.Phone, &d.OwnerName, &d.Status, &d.Why); e != nil {
			return nil, apperr.Internal(e)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func digitsOnly(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func (s *Service) CreateProspect(ctx context.Context, in crm.ProspectInput) (*crm.Prospect, error) {
	name := strings.TrimSpace(in.ClinicName)
	if name == "" {
		return nil, apperr.Validation("the clinic needs a name")
	}
	if in.Source == "" {
		in.Source = "field"
	}
	if in.Priority == "" {
		in.Priority = "warm"
	}
	owner := in.OwnerID
	if owner == nil {
		// Whoever collected it owns it, unless an admin said otherwise.
		owner = actor(ctx)
	}
	var pid uuid.UUID
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `
			INSERT INTO crm_prospects (clinic_name, contact_name, contact_role, phone, phone_alt, email,
			                           address, map_url, note, source, priority, owner_id, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
			name, nz(in.ContactName), nz(in.ContactRole), nz(in.Phone), nz(in.PhoneAlt), nz(in.Email),
			nz(in.Address), nz(in.MapURL), nz(in.Note), in.Source, in.Priority, owner, actor(ctx)).Scan(&pid); e != nil {
			return e
		}
		if in.CampaignID != nil {
			return enrolTx(ctx, tx, pid, *in.CampaignID, actor(ctx))
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	p, _, _, err := s.GetProspect(ctx, pid)
	return p, err
}

func (s *Service) UpdateProspect(ctx context.Context, pid uuid.UUID, in crm.ProspectInput) error {
	if strings.TrimSpace(in.ClinicName) == "" {
		return apperr.Validation("the clinic needs a name")
	}
	ct, err := s.db.Pool.Exec(ctx, `
		UPDATE crm_prospects SET clinic_name=$2, contact_name=$3, contact_role=$4, phone=$5, phone_alt=$6,
		       email=$7, address=$8, map_url=$9, note=$10, updated_at=now()
		 WHERE id=$1 AND deleted_at IS NULL`,
		pid, strings.TrimSpace(in.ClinicName), nz(in.ContactName), nz(in.ContactRole), nz(in.Phone),
		nz(in.PhoneAlt), nz(in.Email), nz(in.Address), nz(in.MapURL), nz(in.Note))
	if err != nil {
		return apperr.Internal(err)
	}
	if ct.RowsAffected() == 0 {
		return apperr.NotFound("PROSPECT_NOT_FOUND", "that clinic is not in the pipeline")
	}
	return nil
}

func (s *Service) Assign(ctx context.Context, pid uuid.UUID, ownerID *uuid.UUID) error {
	if _, err := s.db.Pool.Exec(ctx,
		`UPDATE crm_prospects SET owner_id=$2, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`,
		pid, ownerID); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

/* ------------------------------------------------------- the pipeline */

// enrolTx puts a prospect on phase 1 of a campaign, ending whatever it was in before.
func enrolTx(ctx context.Context, tx pgx.Tx, pid, cid uuid.UUID, by *uuid.UUID) error {
	var first uuid.UUID
	e := tx.QueryRow(ctx, `SELECT id FROM crm_phases WHERE campaign_id=$1 ORDER BY seq LIMIT 1`, cid).Scan(&first)
	if errors.Is(e, pgx.ErrNoRows) {
		return apperr.Validation("that campaign has no phases yet")
	}
	if e != nil {
		return e
	}
	// One live campaign at a time: at phase 2 of one and phase 4 of another is not a
	// state anybody can act on, and the board would show the clinic twice.
	if _, e := tx.Exec(ctx,
		`UPDATE crm_enrollments SET status='dropped', finished_at=now()
		  WHERE prospect_id=$1 AND status='active'`, pid); e != nil {
		return e
	}
	_, e = tx.Exec(ctx,
		`INSERT INTO crm_enrollments (prospect_id, campaign_id, phase_id, created_by) VALUES ($1,$2,$3,$4)`,
		pid, cid, first, by)
	return e
}

func (s *Service) Enrol(ctx context.Context, pid, cid uuid.UUID) error {
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error { return enrolTx(ctx, tx, pid, cid, actor(ctx)) })
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// CompletePhase marks the step the clinic is on as done and moves it to the next.
//
// On the last phase it does NOT invent an outcome: finishing the steps and winning
// the clinic are different facts, and the rep is the one who knows which happened.
// The enrollment closes and the prospect waits for an outcome to be recorded.
func (s *Service) CompletePhase(ctx context.Context, pid uuid.UUID, note string) (*crm.Prospect, error) {
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var enr, phase, camp uuid.UUID
		var seq int
		e := tx.QueryRow(ctx, `
			SELECT e.id, e.phase_id, e.campaign_id, ph.seq
			  FROM crm_enrollments e JOIN crm_phases ph ON ph.id = e.phase_id
			 WHERE e.prospect_id=$1 AND e.status='active'`, pid).Scan(&enr, &phase, &camp, &seq)
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.Validation("this clinic is not in a campaign right now")
		}
		if e != nil {
			return e
		}
		if _, e := tx.Exec(ctx,
			`INSERT INTO crm_phase_events (enrollment_id, phase_id, note, done_by) VALUES ($1,$2,$3,$4)`,
			enr, phase, nz(note), actor(ctx)); e != nil {
			return e
		}
		var next uuid.UUID
		e = tx.QueryRow(ctx, `SELECT id FROM crm_phases WHERE campaign_id=$1 AND seq > $2 ORDER BY seq LIMIT 1`,
			camp, seq).Scan(&next)
		if errors.Is(e, pgx.ErrNoRows) {
			_, e2 := tx.Exec(ctx,
				`UPDATE crm_enrollments SET status='finished', phase_id=NULL, finished_at=now() WHERE id=$1`, enr)
			return e2
		}
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `UPDATE crm_enrollments SET phase_id=$2 WHERE id=$1`, enr, next)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	p, _, _, err := s.GetProspect(ctx, pid)
	return p, err
}

func (s *Service) SetOutcome(ctx context.Context, pid uuid.UUID, out crm.Outcome) error {
	switch out.Status {
	case "signed_up", "not_interested":
	case "not_yet":
		if strings.TrimSpace(out.ReadyOn) == "" {
			return apperr.Validation("say when to come back — without a date this is the same as a no")
		}
		if _, e := time.Parse("2006-01-02", out.ReadyOn); e != nil {
			return apperr.Validation("the come-back date must be a real date")
		}
	default:
		return apperr.Validation("unknown outcome")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `
			UPDATE crm_prospects SET status=$2, ready_on=$3, outcome_note=$4, updated_at=now()
			 WHERE id=$1 AND deleted_at IS NULL`,
			pid, out.Status, nz(out.ReadyOn), nz(out.Note)); e != nil {
			return e
		}
		// A decided clinic is off the board either way; the record keeps the story.
		_, e := tx.Exec(ctx,
			`UPDATE crm_enrollments SET status='finished', finished_at=now()
			  WHERE prospect_id=$1 AND status='active'`, pid)
		return e
	})
	if ae, ok := apperr.As(err); ok {
		return ae
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) Reopen(ctx context.Context, pid uuid.UUID) error {
	if _, err := s.db.Pool.Exec(ctx,
		`UPDATE crm_prospects SET status='open', ready_on=NULL, updated_at=now()
		  WHERE id=$1 AND deleted_at IS NULL`, pid); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

func (s *Service) LogTouch(ctx context.Context, pid uuid.UUID, kind, note, happenedAt string) error {
	switch kind {
	case "call", "visit", "message", "note":
	default:
		return apperr.Validation("a touch is a call, a visit, a message or a note")
	}
	when := time.Now()
	if strings.TrimSpace(happenedAt) != "" {
		t, e := time.Parse(time.RFC3339, happenedAt)
		if e != nil {
			return apperr.Validation("that is not a real date and time")
		}
		when = t
	}
	if _, err := s.db.Pool.Exec(ctx,
		`INSERT INTO crm_touches (prospect_id, kind, note, happened_at, by_id) VALUES ($1,$2,$3,$4,$5)`,
		pid, kind, nz(note), when, actor(ctx)); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

/* ------------------------------------------------------------- the board */

func (s *Service) GetBoard(ctx context.Context, cid uuid.UUID) (*crm.Board, error) {
	var b crm.Board
	if e := s.db.Pool.QueryRow(ctx,
		`SELECT id, name, coalesce(goal,''), is_active, created_at FROM crm_campaigns WHERE id=$1`, cid).
		Scan(&b.Campaign.ID, &b.Campaign.Name, &b.Campaign.Goal, &b.Campaign.IsActive, &b.Campaign.Created); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, apperr.NotFound("CAMPAIGN_NOT_FOUND", "no such campaign")
		}
		return nil, apperr.Internal(e)
	}
	prows, err := s.db.Pool.Query(ctx,
		`SELECT id, seq, name, coalesce(intent,'') FROM crm_phases WHERE campaign_id=$1 ORDER BY seq`, cid)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer prows.Close()
	cols := []crm.BoardCol{}
	idx := map[uuid.UUID]int{}
	for prows.Next() {
		var ph crm.Phase
		if e := prows.Scan(&ph.ID, &ph.Seq, &ph.Name, &ph.Intent); e != nil {
			return nil, apperr.Internal(e)
		}
		idx[ph.ID] = len(cols)
		cols = append(cols, crm.BoardCol{Phase: ph, Prospects: []crm.Prospect{}})
	}
	if e := prows.Err(); e != nil {
		return nil, apperr.Internal(e)
	}

	rows, err := s.db.Pool.Query(ctx, `SELECT `+prospectCols+prospectFrom+`
		 WHERE p.deleted_at IS NULL AND e.campaign_id = $1 AND e.status = 'active'
		 ORDER BY coalesce(t.happened_at, p.created_at)`, cid)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	for rows.Next() {
		p, e := scanProspect(rows)
		if e != nil {
			return nil, apperr.Internal(e)
		}
		if p.PhaseID != nil {
			if i, ok := idx[*p.PhaseID]; ok {
				cols[i].Prospects = append(cols[i].Prospects, p)
				cols[i].Phase.Waiting++
			}
		}
	}
	b.Columns = cols
	return &b, rows.Err()
}

// ImportInbound turns website enquiries into prospects.
//
// The pop-up on clinicos.cc already collects them; until now they sat in their own
// list and nobody worked them. One prospect per lead — the unique key on
// partner_lead_id means running this twice cannot duplicate the pipeline.
func (s *Service) ImportInbound(ctx context.Context, campaignID *uuid.UUID) (int, error) {
	n := 0
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `
			SELECT l.id, l.name, coalesce(l.phone,''), coalesce(l.email,''), coalesce(l.region,'')
			  FROM partner_leads l
			 WHERE NOT EXISTS (SELECT 1 FROM crm_prospects p WHERE p.partner_lead_id = l.id)
			 ORDER BY l.created_at`)
		if e != nil {
			return e
		}
		type lead struct {
			id                         uuid.UUID
			name, phone, email, region string
		}
		var leads []lead
		for rows.Next() {
			var l lead
			if e := rows.Scan(&l.id, &l.name, &l.phone, &l.email, &l.region); e != nil {
				rows.Close()
				return e
			}
			leads = append(leads, l)
		}
		rows.Close()
		for _, l := range leads {
			var pid uuid.UUID
			if e := tx.QueryRow(ctx, `
				INSERT INTO crm_prospects (clinic_name, contact_name, phone, email, address,
				                           source, partner_lead_id, created_by)
				VALUES ($1,$2,$3,$4,$5,'inbound',$6,$7) RETURNING id`,
				l.name, nz(l.name), nz(l.phone), nz(l.email), nz(l.region), l.id, actor(ctx)).Scan(&pid); e != nil {
				return e
			}
			if campaignID != nil {
				if e := enrolTx(ctx, tx, pid, *campaignID, actor(ctx)); e != nil {
					return e
				}
			}
			n++
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return 0, ae
	}
	if err != nil {
		return 0, apperr.Internal(err)
	}
	return n, nil
}
