// Package service implements the CRM use-cases on the privileged (RLS-bypassing)
// connection, the same one the platform console uses. Nothing here is tenant-scoped.
package service

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/crm"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
)

type Service struct{ db *kerneldb.DB }

var _ crm.Service = (*Service)(nil)

func NewService(db *kerneldb.DB) *Service { return &Service{db: db} }

// actor is the platform account making the request, taken from the token.
type ctxKey struct{}

// WithActor stores the acting platform admin on the context.
func WithActor(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}
func actor(ctx context.Context) *uuid.UUID {
	if v, ok := ctx.Value(ctxKey{}).(uuid.UUID); ok && v != uuid.Nil {
		return &v
	}
	return nil
}

func nz(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}
func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

/* ------------------------------------------------------------ campaigns */

func (s *Service) ListCampaigns(ctx context.Context) ([]crm.Campaign, error) {
	out := []crm.Campaign{}
	rows, err := s.db.Pool.Query(ctx, `
		SELECT c.id, c.name, coalesce(c.goal,''), c.is_active, c.created_at,
		       count(*) FILTER (WHERE e.status = 'active') AS active,
		       count(*) FILTER (WHERE p.status = 'signed_up') AS signed_up
		  FROM crm_campaigns c
		  LEFT JOIN crm_enrollments e ON e.campaign_id = c.id
		  LEFT JOIN crm_prospects   p ON p.id = e.prospect_id AND p.deleted_at IS NULL
		 WHERE c.archived_at IS NULL
		 GROUP BY c.id
		 ORDER BY c.is_active DESC, c.created_at DESC`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	byID := map[uuid.UUID]int{}
	for rows.Next() {
		var c crm.Campaign
		if err := rows.Scan(&c.ID, &c.Name, &c.Goal, &c.IsActive, &c.Created, &c.Active, &c.SignedUp); err != nil {
			return nil, apperr.Internal(err)
		}
		c.Phases = []crm.Phase{}
		byID[c.ID] = len(out)
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Internal(err)
	}
	if len(out) == 0 {
		return out, nil
	}

	// Phases with the number of prospects standing on each — a campaign without
	// them is a definition, not a pipeline.
	prows, err := s.db.Pool.Query(ctx, `
		SELECT ph.campaign_id, ph.id, ph.seq, ph.name, coalesce(ph.intent,''),
		       count(e.id) FILTER (WHERE e.status = 'active') AS waiting
		  FROM crm_phases ph
		  LEFT JOIN crm_enrollments e ON e.phase_id = ph.id
		 GROUP BY ph.id
		 ORDER BY ph.campaign_id, ph.seq`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer prows.Close()
	for prows.Next() {
		var cid uuid.UUID
		var ph crm.Phase
		if err := prows.Scan(&cid, &ph.ID, &ph.Seq, &ph.Name, &ph.Intent, &ph.Waiting); err != nil {
			return nil, apperr.Internal(err)
		}
		if i, ok := byID[cid]; ok {
			out[i].Phases = append(out[i].Phases, ph)
		}
	}
	return out, prows.Err()
}

func (s *Service) CreateCampaign(ctx context.Context, in crm.CampaignInput) (*crm.Campaign, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, apperr.Validation("give the campaign a name")
	}
	if len(in.Phases) == 0 {
		return nil, apperr.Validation("a campaign needs at least one phase")
	}
	var out crm.Campaign
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx,
			`INSERT INTO crm_campaigns (name, goal, created_by) VALUES ($1,$2,$3)
			 RETURNING id, name, coalesce(goal,''), is_active, created_at`,
			name, nz(in.Goal), actor(ctx)).
			Scan(&out.ID, &out.Name, &out.Goal, &out.IsActive, &out.Created); e != nil {
			return e
		}
		out.Phases = []crm.Phase{}
		for i, p := range in.Phases {
			n := strings.TrimSpace(p.Name)
			if n == "" {
				return apperr.Validation("every phase needs a name")
			}
			var ph crm.Phase
			if e := tx.QueryRow(ctx,
				`INSERT INTO crm_phases (campaign_id, seq, name, intent) VALUES ($1,$2,$3,$4)
				 RETURNING id, seq, name, coalesce(intent,'')`,
				out.ID, i+1, n, nz(p.Intent)).Scan(&ph.ID, &ph.Seq, &ph.Name, &ph.Intent); e != nil {
				return e
			}
			out.Phases = append(out.Phases, ph)
		}
		return nil
	})
	if ae, ok := apperr.As(err); ok {
		return nil, ae
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

// UpdateCampaign renames the campaign and rewrites its phases in the given order.
//
// Phases that already exist keep their id — and therefore every prospect standing on
// them and every completed step that refers to them. Renaming "First call" or moving
// it must not empty the pipeline, which is what deleting and re-inserting would do.
func (s *Service) UpdateCampaign(ctx context.Context, cid uuid.UUID, in crm.CampaignInput) error {
	if strings.TrimSpace(in.Name) == "" {
		return apperr.Validation("give the campaign a name")
	}
	if len(in.Phases) == 0 {
		return apperr.Validation("a campaign needs at least one phase")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `UPDATE crm_campaigns SET name=$2, goal=$3, updated_at=now() WHERE id=$1`,
			cid, strings.TrimSpace(in.Name), nz(in.Goal)); e != nil {
			return e
		}
		keep := map[uuid.UUID]bool{}
		// Two passes: park every sequence out of range first, so re-ordering cannot
		// collide with the unique (campaign, seq) index halfway through.
		if _, e := tx.Exec(ctx, `UPDATE crm_phases SET seq = -seq WHERE campaign_id=$1`, cid); e != nil {
			return e
		}
		for i, p := range in.Phases {
			n := strings.TrimSpace(p.Name)
			if n == "" {
				return apperr.Validation("every phase needs a name")
			}
			if p.ID != "" {
				pid, e := decodePhase(p.ID)
				if e != nil {
					return apperr.Validation("unknown phase")
				}
				var got uuid.UUID
				if e := tx.QueryRow(ctx,
					`UPDATE crm_phases SET seq=$3, name=$4, intent=$5
					  WHERE id=$1 AND campaign_id=$2 RETURNING id`,
					pid, cid, i+1, n, nz(p.Intent)).Scan(&got); e != nil {
					if errors.Is(e, pgx.ErrNoRows) {
						return apperr.Validation("that phase is not part of this campaign")
					}
					return e
				}
				keep[got] = true
				continue
			}
			var nid uuid.UUID
			if e := tx.QueryRow(ctx,
				`INSERT INTO crm_phases (campaign_id, seq, name, intent) VALUES ($1,$2,$3,$4) RETURNING id`,
				cid, i+1, n, nz(p.Intent)).Scan(&nid); e != nil {
				return e
			}
			keep[nid] = true
		}
		// A removed phase can only go if nobody is standing on it and nobody ever
		// completed it. Otherwise the history would lose the step it refers to.
		ids := make([]uuid.UUID, 0, len(keep))
		for k := range keep {
			ids = append(ids, k)
		}
		var stuck int
		if e := tx.QueryRow(ctx, `
			SELECT count(*) FROM crm_phases ph
			 WHERE ph.campaign_id=$1 AND NOT (ph.id = ANY($2::uuid[]))
			   AND (EXISTS (SELECT 1 FROM crm_enrollments e WHERE e.phase_id = ph.id)
			     OR EXISTS (SELECT 1 FROM crm_phase_events v WHERE v.phase_id = ph.id))`,
			cid, ids).Scan(&stuck); e != nil {
			return e
		}
		if stuck > 0 {
			return apperr.Validation("a phase you removed still has clinics on it or a completed step behind it — move them on first")
		}
		_, e := tx.Exec(ctx, `DELETE FROM crm_phases WHERE campaign_id=$1 AND NOT (id = ANY($2::uuid[]))`, cid, ids)
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

func (s *Service) SetCampaignActive(ctx context.Context, cid uuid.UUID, active bool) error {
	if _, err := s.db.Pool.Exec(ctx,
		`UPDATE crm_campaigns SET is_active=$2, updated_at=now() WHERE id=$1`, cid, active); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

/* ------------------------------------------------------------------ reps */

func (s *Service) ListReps(ctx context.Context) ([]crm.Rep, error) {
	rows, err := s.db.Pool.Query(ctx, `
		SELECT a.id, a.email, coalesce(a.full_name,''), a.role, a.status,
		       count(p.id) FILTER (WHERE p.status = 'open')      AS open,
		       count(p.id) FILTER (WHERE p.status = 'signed_up') AS signed_up
		  FROM platform_admins a
		  LEFT JOIN crm_prospects p ON p.owner_id = a.id AND p.deleted_at IS NULL
		 GROUP BY a.id ORDER BY a.role, a.full_name, a.email`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []crm.Rep{}
	for rows.Next() {
		var r crm.Rep
		if err := rows.Scan(&r.ID, &r.Email, &r.FullName, &r.Role, &r.Status, &r.Open, &r.SignedUp); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Service) CreateRep(ctx context.Context, email, fullName, role, password string) (*crm.Rep, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	fullName = strings.TrimSpace(fullName)
	if email == "" || fullName == "" {
		return nil, apperr.Validation("name and email are required")
	}
	if role != "admin" && role != "marketer" {
		role = "marketer"
	}
	if len(password) < 10 {
		return nil, apperr.Validation("give them a password of at least 10 characters")
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	var r crm.Rep
	e := s.db.Pool.QueryRow(ctx,
		`INSERT INTO platform_admins (email, full_name, role, password_hash, status)
		 VALUES ($1,$2,$3,$4,'active')
		 RETURNING id, email, coalesce(full_name,''), role, status`,
		email, fullName, role, hash).Scan(&r.ID, &r.Email, &r.FullName, &r.Role, &r.Status)
	if e != nil {
		if strings.Contains(e.Error(), "duplicate") || strings.Contains(e.Error(), "unique") {
			return nil, apperr.Conflict("EMAIL_TAKEN", "somebody already uses that email")
		}
		return nil, apperr.Internal(e)
	}
	return &r, nil
}

func (s *Service) SetRepStatus(ctx context.Context, id uuid.UUID, status string) error {
	if status != "active" && status != "disabled" {
		return apperr.Validation("status must be active or disabled")
	}
	if _, err := s.db.Pool.Exec(ctx,
		`UPDATE platform_admins SET status=$2, updated_at=now() WHERE id=$1`, id, status); err != nil {
		return apperr.Internal(err)
	}
	return nil
}
