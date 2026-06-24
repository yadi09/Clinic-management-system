// Package service implements the platform (super-admin) use-cases on a privileged
// (RLS-bypassing) connection: authenticate platform admins and provision / list /
// suspend tenants across the multi-tenant boundary.
package service

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/platform"
	"github.com/reicb/clinicsaas/internal/platform/provision"
)

// Service implements platform.Service. db is a PRIVILEGED connection (the
// platform operates above tenant RLS); tokens issues platform access tokens.
type Service struct {
	db     *kerneldb.DB
	tokens *auth.TokenService
}

var _ platform.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, tokens *auth.TokenService) *Service {
	return &Service{db: db, tokens: tokens}
}

var slugRe = regexp.MustCompile(`[^a-z0-9-]+`)

// Authenticate verifies a platform admin's credentials and returns an access
// token carrying the platform.admin permission (tenant-less).
func (s *Service) Authenticate(ctx context.Context, email, password string) (*platform.Login, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var id uuid.UUID
	var hash, status string
	err := s.db.Pool.QueryRow(ctx,
		`SELECT id, password_hash, status FROM platform_admins WHERE email = $1`, email).Scan(&id, &hash, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.Unauthenticated("invalid credentials")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	if ok, _ := auth.VerifyPassword(password, hash); !ok {
		return nil, apperr.Unauthenticated("invalid credentials")
	}
	if status != "active" {
		return nil, apperr.Forbidden("ADMIN_INACTIVE", "this platform admin is not active")
	}
	tok, exp, err := s.tokens.IssueAccess(id, uuid.Nil, email, []string{"platform_admin"}, []string{"platform.admin"}, nil)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	_, _ = s.db.Pool.Exec(ctx, `UPDATE platform_admins SET last_login_at = now() WHERE id = $1`, id)
	return &platform.Login{Token: tok, ExpiresAt: exp, Email: email}, nil
}

// ProvisionClinic stands up a new clinic + owner. Idempotency is rejected: an
// existing slug is a conflict (the operator picks a fresh workspace).
func (s *Service) ProvisionClinic(ctx context.Context, in platform.ProvisionInput) (*platform.ProvisionResult, error) {
	name := strings.TrimSpace(in.ClinicName)
	slug := slugRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(in.Slug)), "-")
	slug = strings.Trim(slug, "-")
	email := strings.ToLower(strings.TrimSpace(in.OwnerEmail))
	owner := strings.TrimSpace(in.OwnerName)
	if name == "" || slug == "" || email == "" || owner == "" {
		return nil, apperr.Validation("clinic name, workspace slug, owner name and owner email are required")
	}

	var exists bool
	if err := s.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tenants WHERE slug = $1)`, slug).Scan(&exists); err != nil {
		return nil, apperr.Internal(err)
	}
	if exists {
		return nil, apperr.Conflict("SLUG_TAKEN", "that workspace already exists — choose another")
	}

	tempPass := in.OwnerPassword
	generated := false
	if strings.TrimSpace(tempPass) == "" {
		tempPass = generatePassword()
		generated = true
	}
	hash, err := auth.HashPassword(tempPass)
	if err != nil {
		return nil, apperr.Internal(err)
	}

	var res provision.Result
	err = s.db.WithTenantTx(ctx, uuid.Nil, func(tx pgx.Tx) error {
		var e error
		res, e = provision.BootstrapTenant(ctx, tx, provision.Params{
			Name: name, Slug: slug, OwnerEmail: email, OwnerName: owner, OwnerPasswordHash: hash, Flags: in.Modules,
		})
		return e
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}

	out := &platform.ProvisionResult{
		Clinic: platform.ClinicSummary{
			TenantID: res.TenantID, Name: name, Slug: slug, Status: "active", OwnerEmail: email, Users: 1, CreatedAt: time.Now(),
		},
		OwnerEmail: email, WorkspaceSlug: slug,
	}
	if generated {
		out.TempPassword = tempPass
	}
	return out, nil
}

func (s *Service) ListClinics(ctx context.Context) ([]platform.ClinicSummary, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT t.id, t.name, t.slug, t.status, t.created_at,
		   (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::int,
		   (SELECT count(*) FROM patients p WHERE p.tenant_id = t.id)::int
		 FROM tenants t WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []platform.ClinicSummary{}
	for rows.Next() {
		var c platform.ClinicSummary
		if err := rows.Scan(&c.TenantID, &c.Name, &c.Slug, &c.Status, &c.CreatedAt, &c.Users, &c.Patients); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Service) SetClinicStatus(ctx context.Context, tenantID uuid.UUID, status string) error {
	if status != "active" && status != "suspended" {
		return apperr.Validation("status must be active or suspended")
	}
	ct, err := s.db.Pool.Exec(ctx,
		`UPDATE tenants SET status = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL`, status, tenantID)
	if err != nil {
		return apperr.Internal(err)
	}
	if ct.RowsAffected() == 0 {
		return apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
	}
	return nil
}

func (s *Service) GetClinicModules(ctx context.Context, tenantID uuid.UUID) (map[string]bool, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT flag, enabled FROM feature_flags WHERE tenant_id = $1`, tenantID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var flag string
		var enabled bool
		if err := rows.Scan(&flag, &enabled); err != nil {
			return nil, apperr.Internal(err)
		}
		out[flag] = enabled
	}
	return out, rows.Err()
}

// SetClinicModules upserts the given module entitlements for a clinic. Only known
// module flags are accepted (others are ignored). Takes effect on next token refresh.
func (s *Service) SetClinicModules(ctx context.Context, tenantID uuid.UUID, modules map[string]bool) error {
	allowed := map[string]bool{}
	for _, m := range platform.ModuleFlags {
		allowed[m.Key] = true
	}
	for flag, enabled := range modules {
		if !allowed[flag] {
			continue
		}
		if _, err := s.db.Pool.Exec(ctx,
			`INSERT INTO feature_flags (tenant_id, flag, enabled, source) VALUES ($1,$2,$3,'override')
			 ON CONFLICT (tenant_id, flag) DO UPDATE SET enabled = EXCLUDED.enabled, source = 'override'`,
			tenantID, flag, enabled); err != nil {
			return apperr.Internal(err)
		}
	}
	return nil
}

// generatePassword returns a readable 16-char temporary password.
func generatePassword() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return "Cl1-" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}
