package service

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/campaign"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
)

// SignUp records a clinic's interest.
//
// Open to anyone with the link and deliberately forgiving: a clinic sending the
// form twice is correcting a typo, not cheating, so the second one replaces the
// first rather than being refused. Nothing here touches the draw — signing up
// claims no position on the wheel.
func (s *Service) SignUp(ctx context.Context, code string, in campaign.SignupInput) error {
	r, err := s.byCode(ctx, code)
	if err != nil {
		return err
	}
	if r.status == "closed" {
		return apperr.Validation("this campaign has closed")
	}
	if strings.TrimSpace(in.Honeypot) != "" {
		return nil // a bot; answer as if it worked and store nothing
	}
	owner := strings.TrimSpace(in.OwnerName)
	clinic := strings.TrimSpace(in.ClinicName)
	place := strings.TrimSpace(in.Location)
	if owner == "" {
		return apperr.Validation("please tell us your name").WithField("owner_name", "required")
	}
	if clinic == "" {
		return apperr.Validation("please tell us the clinic's name").WithField("clinic_name", "required")
	}
	if place == "" {
		return apperr.Validation("please tell us where the clinic is").WithField("location", "required")
	}
	tel, ok := phone.Normalise(in.Phone)
	if !ok || tel == "" {
		return apperr.Validation("we need a phone number we can reach you on").WithField("phone", "invalid")
	}
	facilities := make([]string, 0, len(in.Facilities))
	for _, f := range in.Facilities {
		if f = strings.TrimSpace(f); f != "" && len(f) < 60 {
			facilities = append(facilities, f)
		}
	}
	structure := strings.TrimSpace(in.Structure)
	if len(structure) > 2000 {
		structure = structure[:2000]
	}
	_, err = s.db.Pool.Exec(ctx, `
		INSERT INTO campaign_signups (campaign_id, owner_name, phone, clinic_name, location, structure, facilities)
		VALUES ($1,$2,$3,$4,$5,nullif($6,''),$7)
		ON CONFLICT (campaign_id, phone) DO UPDATE
		   SET owner_name = EXCLUDED.owner_name, clinic_name = EXCLUDED.clinic_name,
		       location = EXCLUDED.location, structure = EXCLUDED.structure,
		       facilities = EXCLUDED.facilities, updated_at = now()`,
		r.id, owner, tel, clinic, place, structure, facilities)
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// Signups is the list to work through, newest first, each marked with whether
// that number has since taken the quiz.
func (s *Service) Signups(ctx context.Context, campaignID uuid.UUID) ([]campaign.Signup, error) {
	rows, err := s.db.Pool.Query(ctx, `
		SELECT g.id, g.owner_name, g.phone, g.clinic_name, g.location, coalesce(g.structure,''),
		       g.facilities, g.status, coalesce(g.note,''), g.created_at,
		       EXISTS(SELECT 1 FROM campaign_entries e
		               WHERE e.campaign_id = g.campaign_id AND e.phone = g.phone),
		       EXISTS(SELECT 1 FROM campaign_entries e
		               WHERE e.campaign_id = g.campaign_id AND e.phone = g.phone AND e.won)
		  FROM campaign_signups g
		 WHERE g.campaign_id = $1
		 ORDER BY g.created_at DESC`, campaignID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []campaign.Signup{}
	for rows.Next() {
		var g campaign.Signup
		if err := rows.Scan(&g.ID, &g.OwnerName, &g.Phone, &g.ClinicName, &g.Location, &g.Structure,
			&g.Facilities, &g.Status, &g.Note, &g.CreatedAt, &g.Played, &g.Won); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// SetSignupStatus moves a clinic along the outreach list and records why.
func (s *Service) SetSignupStatus(ctx context.Context, signupID uuid.UUID, status, note string) error {
	switch status {
	case "new", "contacted", "invited", "joined", "declined":
	default:
		return apperr.Validation("unknown status")
	}
	ct, err := s.db.Pool.Exec(ctx,
		`UPDATE campaign_signups SET status=$2, note=nullif($3,''), updated_at=now() WHERE id=$1`,
		signupID, status, strings.TrimSpace(note))
	if err != nil {
		return apperr.Internal(err)
	}
	if ct.RowsAffected() == 0 {
		return apperr.NotFound("SIGNUP_NOT_FOUND", "that clinic is not on the list")
	}
	return nil
}
