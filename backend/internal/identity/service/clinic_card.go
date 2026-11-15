package service

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/identity"
	identitydb "github.com/reicb/clinicsaas/internal/identity/repo/gen"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

var clinicCodeRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// errNoClinic is the one answer for a code that is unknown, deleted or not open for
// sign-in: the page cannot tell a suspended clinic from one that never existed.
func errNoClinic() error { return apperr.NotFound("CLINIC_NOT_FOUND", "no clinic with that code") }

// ClinicCard is what the sign-in page shows before anyone signs in: the clinic's
// name and whether it has a logo (served by /verify/logo/:slug). Nothing else
// leaves — no id, plan, status or staff. The same name and logo are already public
// on the clinic's patient page (/p/<slug>) and on its printed papers.
func (s *AuthService) ClinicCard(ctx context.Context, code string) (*identity.ClinicCard, error) {
	slug := strings.ToLower(strings.TrimSpace(code))
	if !clinicCodeRe.MatchString(slug) {
		return nil, errNoClinic()
	}
	var tenant identitydb.GetTenantBySlugRow
	if err := s.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var e error
		tenant, e = identitydb.New(tx).GetTenantBySlug(ctx, slug)
		return e
	}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNoClinic()
		}
		return nil, apperr.Internal(err)
	}
	// The same rule sign-in uses (Login): only these clinics can be entered.
	if tenant.Status != "active" && tenant.Status != "onboarding" {
		return nil, errNoClinic()
	}
	card := &identity.ClinicCard{Name: tenant.Name, Slug: tenant.Slug}
	_ = s.db.WithTenantTx(ctx, tenant.ID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM print_settings WHERE tenant_id = $1 AND coalesce(logo, '') LIKE 'data:image/%')`,
			tenant.ID).Scan(&card.HasLogo)
	})
	return card, nil
}
