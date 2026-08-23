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
	"github.com/reicb/clinicsaas/internal/kernel/limits"
	"github.com/reicb/clinicsaas/internal/platform"
	"github.com/reicb/clinicsaas/internal/platform/provision"
)

// Service implements platform.Service. db is a PRIVILEGED connection (the
// platform operates above tenant RLS); tokens issues platform access tokens.
type Service struct {
	db     *kerneldb.DB
	tokens *auth.TokenService
	// Encrypts the vendor's own credentials at rest — the same key and the same
	// helper that protect a clinic's MFA secret and its DHIS2 token.
	encKey []byte
}

var _ platform.Service = (*Service)(nil)

func NewService(db *kerneldb.DB, tokens *auth.TokenService, encKey []byte) *Service {
	return &Service{db: db, tokens: tokens, encKey: encKey}
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
	tok, exp, err := s.tokens.IssueAccess(id, uuid.Nil, email, []string{"platform_admin"}, []string{"platform.admin"}, nil, nil, "")
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
	clinicType := strings.ToLower(strings.TrimSpace(in.ClinicType))
	if clinicType == "" {
		clinicType = "general"
	}
	if _, ok := provision.ClinicPresets[clinicType]; !ok && clinicType != "general" {
		return nil, apperr.Validation("unknown clinic type")
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
			Name: name, Slug: slug, OwnerEmail: email, OwnerName: owner, OwnerPasswordHash: hash,
			ClinicType: clinicType, PlanCode: strings.ToLower(strings.TrimSpace(in.PlanCode)), Flags: in.Modules,
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
		`SELECT t.id, t.name, t.slug, t.status, t.clinic_type, t.created_at,
		   (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::int,
		   (SELECT count(*) FROM patients p WHERE p.tenant_id = t.id)::int,
		   pl.code, pl.name
		 FROM tenants t JOIN plans pl ON pl.id = t.plan_id
		 WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []platform.ClinicSummary{}
	for rows.Next() {
		var c platform.ClinicSummary
		if err := rows.Scan(&c.TenantID, &c.Name, &c.Slug, &c.Status, &c.ClinicType, &c.CreatedAt, &c.Users, &c.Patients, &c.PlanCode, &c.PlanName); err != nil {
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
	rows, err := s.db.Pool.Query(ctx, `SELECT flag, enabled FROM feature_flags WHERE tenant_id = $1 AND branch_id IS NULL`, tenantID)
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
			 ON CONFLICT (tenant_id, flag) WHERE branch_id IS NULL DO UPDATE SET enabled = EXCLUDED.enabled, source = 'override'`,
			tenantID, flag, enabled); err != nil {
			return apperr.Internal(err)
		}
	}
	return nil
}

// GetClinicPolicies reports the clinic's role policies — decisions about who may
// do what that are genuinely per-clinic rather than product-wide.
func (s *Service) GetClinicPolicies(ctx context.Context, tenantID uuid.UUID) (map[string]bool, error) {
	out := map[string]bool{}
	var doctorRegisters bool
	if err := s.db.Pool.QueryRow(ctx,
		`SELECT doctor_registers_patients FROM tenants WHERE id = $1 AND deleted_at IS NULL`,
		tenantID).Scan(&doctorRegisters); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
		}
		return nil, apperr.Internal(err)
	}
	out[platform.PolicyDoctorRegisters] = doctorRegisters
	return out, nil
}

// SetClinicPolicies stores a policy decision and applies it to the role grants in
// the same transaction, so the console cannot leave the two disagreeing.
//
// The column is the durable record and the grant is derived from it: provisioning
// reconciles each role to exactly RoleGrants plus whatever the columns allow, so
// writing only the grant would see it revoked on the next BootstrapTenant.
//
// Permissions are carried in the access token, so a doctor already signed in keeps
// the old answer until their token refreshes.
func (s *Service) SetClinicPolicies(ctx context.Context, tenantID uuid.UUID, policies map[string]bool) error {
	enabled, ok := policies[platform.PolicyDoctorRegisters]
	if !ok {
		return nil
	}
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return apperr.Internal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE tenants SET doctor_registers_patients = $2, updated_at = now()
		   WHERE id = $1 AND deleted_at IS NULL`, tenantID, enabled)
	if err != nil {
		return apperr.Internal(err)
	}
	if tag.RowsAffected() == 0 {
		return apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
	}

	if enabled {
		_, err = tx.Exec(ctx,
			`INSERT INTO role_permissions (tenant_id, role_id, permission_id)
			 SELECT $1, r.id, p.id FROM roles r, permissions p
			  WHERE r.tenant_id = $1 AND r.code = 'doctor' AND p.code = 'patient.create'
			 ON CONFLICT (role_id, permission_id) DO NOTHING`, tenantID)
	} else {
		_, err = tx.Exec(ctx,
			`DELETE FROM role_permissions rp USING roles r, permissions p
			  WHERE rp.tenant_id = $1 AND rp.role_id = r.id AND rp.permission_id = p.id
			    AND r.tenant_id = $1 AND r.code = 'doctor' AND p.code = 'patient.create'`, tenantID)
	}
	if err != nil {
		return apperr.Internal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ImpersonateOwner mints a tenant access token for a clinic's owner so a
// platform admin can sign in as them (support / setup). Runs on the privileged
// connection, so every lookup is filtered by tenant_id by hand. The token
// carries the owner's real roles/permissions/flags — the same claims a normal
// login embeds — and is short-lived (no refresh), so the session self-expires.
func (s *Service) ImpersonateOwner(ctx context.Context, tenantID uuid.UUID) (*platform.Impersonation, error) {
	var uid uuid.UUID
	var email, fullName string
	err := s.db.Pool.QueryRow(ctx, `
		SELECT u.id, u.email, u.full_name
		FROM users u
		JOIN user_role_scopes urs ON urs.user_id = u.id AND urs.tenant_id = u.tenant_id
		JOIN roles r ON r.id = urs.role_id AND r.tenant_id = u.tenant_id
		WHERE u.tenant_id = $1 AND u.deleted_at IS NULL AND u.status = 'active'
		  AND r.code IN ('tenant_owner','clinic_admin')
		ORDER BY (r.code = 'tenant_owner') DESC, u.created_at
		LIMIT 1`, tenantID).Scan(&uid, &email, &fullName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("OWNER_NOT_FOUND", "this clinic has no active owner to sign in as")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}

	roles, err := s.codes(ctx,
		`SELECT DISTINCT r.code FROM user_role_scopes urs JOIN roles r ON r.id = urs.role_id
		 WHERE urs.tenant_id = $1 AND urs.user_id = $2`, tenantID, uid)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	perms, err := s.codes(ctx,
		`SELECT DISTINCT p.code FROM user_role_scopes urs
		 JOIN role_permissions rp ON rp.role_id = urs.role_id
		 JOIN permissions p ON p.id = rp.permission_id
		 WHERE urs.tenant_id = $1 AND urs.user_id = $2`, tenantID, uid)
	if err != nil {
		return nil, apperr.Internal(err)
	}

	flags := map[string]bool{}
	frows, err := s.db.Pool.Query(ctx, `SELECT flag, enabled FROM feature_flags WHERE tenant_id = $1 AND branch_id IS NULL`, tenantID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	for frows.Next() {
		var f string
		var en bool
		if e := frows.Scan(&f, &en); e != nil {
			frows.Close()
			return nil, apperr.Internal(e)
		}
		flags[f] = en
	}
	frows.Close()

	var slug string
	if e := s.db.Pool.QueryRow(ctx, `SELECT slug FROM tenants WHERE id = $1 AND deleted_at IS NULL`, tenantID).Scan(&slug); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
		}
		return nil, apperr.Internal(e)
	}

	access, exp, err := s.tokens.IssueAccess(uid, tenantID, email, roles, perms, flags, nil, "")
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &platform.Impersonation{
		AccessToken:   access,
		ExpiresIn:     int(time.Until(exp).Seconds()),
		WorkspaceSlug: slug,
		User:          platform.ImpersonatedUser{ID: uid, TenantID: tenantID, Email: email, FullName: fullName, Roles: roles},
	}, nil
}

// codes runs a single-column text query on the privileged pool.
func (s *Service) codes(ctx context.Context, q string, args ...any) ([]string, error) {
	rows, err := s.db.Pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if e := rows.Scan(&c); e != nil {
			return nil, e
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// generatePassword returns a readable 16-char temporary password.
func generatePassword() string {
	b := make([]byte, 10)
	_, _ = rand.Read(b)
	return "Cl1-" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

// --- subscription plans (super-admin only, privileged connection) ---

func (s *Service) ListPlans(ctx context.Context) ([]platform.Plan, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT p.id, p.code, p.name, p.clinic_type, p.branch_limit, p.user_limit, p.storage_gb, p.patient_limit, p.images_per_patient,
		        coalesce(p.price_monthly,0)::text,
		        (SELECT count(*) FROM tenants t WHERE t.plan_id = p.id AND t.deleted_at IS NULL)::int
		 FROM plans p ORDER BY p.clinic_type, coalesce(p.price_monthly,0), p.name`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []platform.Plan{}
	for rows.Next() {
		var p platform.Plan
		if e := rows.Scan(&p.ID, &p.Code, &p.Name, &p.ClinicType, &p.BranchLimit, &p.UserLimit, &p.StorageGB, &p.PatientLimit, &p.ImagesPerPatient, &p.PriceMonthly, &p.InUse); e != nil {
			return nil, apperr.Internal(e)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// normClinicType validates + defaults a plan's clinic-type scope.
func normClinicType(t string) (string, bool) {
	t = strings.ToLower(strings.TrimSpace(t))
	if t == "" {
		return "all", true
	}
	switch t {
	case "all", "general", "dental":
		return t, true
	}
	return "", false
}

func (s *Service) CreatePlan(ctx context.Context, in platform.PlanInput) (*platform.Plan, error) {
	code := strings.ToLower(strings.TrimSpace(in.Code))
	name := strings.TrimSpace(in.Name)
	if code == "" || name == "" {
		return nil, apperr.Validation("plan code and name are required")
	}
	clinicType, ok := normClinicType(in.ClinicType)
	if !ok {
		return nil, apperr.Validation("clinic type must be all, general, or dental")
	}
	var taken bool
	if e := s.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM plans WHERE code = $1)`, code).Scan(&taken); e != nil {
		return nil, apperr.Internal(e)
	}
	if taken {
		return nil, apperr.Conflict("PLAN_CODE_TAKEN", "a plan with that code already exists")
	}
	var id uuid.UUID
	if e := s.db.Pool.QueryRow(ctx,
		`INSERT INTO plans (code, name, clinic_type, branch_limit, user_limit, storage_gb, patient_limit, images_per_patient, price_monthly)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric) RETURNING id`,
		code, name, clinicType, in.BranchLimit, in.UserLimit, in.StorageGB, in.PatientLimit, in.ImagesPerPatient, priceOr0(in.PriceMonthly)).Scan(&id); e != nil {
		return nil, apperr.Internal(e)
	}
	return &platform.Plan{ID: id, Code: code, Name: name, ClinicType: clinicType, BranchLimit: in.BranchLimit, UserLimit: in.UserLimit, StorageGB: in.StorageGB, PatientLimit: in.PatientLimit, ImagesPerPatient: in.ImagesPerPatient, PriceMonthly: priceOr0(in.PriceMonthly)}, nil
}

func (s *Service) UpdatePlan(ctx context.Context, id uuid.UUID, in platform.PlanInput) error {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return apperr.Validation("plan name is required")
	}
	clinicType, ok := normClinicType(in.ClinicType)
	if !ok {
		return apperr.Validation("clinic type must be all, general, or dental")
	}
	ct, err := s.db.Pool.Exec(ctx,
		`UPDATE plans SET name=$2, clinic_type=$3, branch_limit=$4, user_limit=$5, storage_gb=$6, patient_limit=$7, images_per_patient=$8, price_monthly=$9::numeric, updated_at=now()
		 WHERE id=$1`,
		id, name, clinicType, in.BranchLimit, in.UserLimit, in.StorageGB, in.PatientLimit, in.ImagesPerPatient, priceOr0(in.PriceMonthly))
	if err != nil {
		return apperr.Internal(err)
	}
	if ct.RowsAffected() == 0 {
		return apperr.NotFound("PLAN_NOT_FOUND", "plan not found")
	}
	return nil
}

// SetClinicPlan assigns a clinic to a plan and stores its per-clinic overrides.
func (s *Service) SetClinicPlan(ctx context.Context, tenantID uuid.UUID, in platform.ClinicPlanInput) error {
	// A clinic can only be put on a plan meant for its type (or a universal 'all'
	// plan). This is the server-side guard against cross-type plan assignment.
	var planType, tenantType string
	if e := s.db.Pool.QueryRow(ctx, `SELECT clinic_type FROM plans WHERE id = $1`, in.PlanID).Scan(&planType); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.Validation("unknown plan")
		}
		return apperr.Internal(e)
	}
	if e := s.db.Pool.QueryRow(ctx, `SELECT clinic_type FROM tenants WHERE id = $1 AND deleted_at IS NULL`, tenantID).Scan(&tenantType); e != nil {
		if errors.Is(e, pgx.ErrNoRows) {
			return apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
		}
		return apperr.Internal(e)
	}
	if planType != "all" && planType != tenantType {
		return apperr.Validation("that plan isn't available for this clinic type")
	}
	ct, err := s.db.Pool.Exec(ctx,
		`UPDATE tenants SET plan_id=$2, storage_gb_override=$3, patient_limit_override=$4, user_limit_override=$5, branch_limit_override=$6, updated_at=now()
		 WHERE id=$1 AND deleted_at IS NULL`,
		tenantID, in.PlanID, in.StorageGBOverride, in.PatientLimitOverride, in.UserLimitOverride, in.BranchLimitOverride)
	if err != nil {
		return apperr.Internal(err)
	}
	if ct.RowsAffected() == 0 {
		return apperr.NotFound("CLINIC_NOT_FOUND", "clinic not found")
	}
	_, _ = s.db.Pool.Exec(ctx, `UPDATE subscriptions SET plan_id=$2, updated_at=now() WHERE tenant_id=$1`, tenantID, in.PlanID)
	return nil
}

// ClinicUsage computes a clinic's effective caps + current usage (super-admin view).
func (s *Service) ClinicUsage(ctx context.Context, tenantID uuid.UUID) (*platform.ClinicUsage, error) {
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer tx.Rollback(ctx)
	l, err := limits.Effective(ctx, tx, tenantID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	storage, _ := limits.StorageUsed(ctx, tx, tenantID)
	patients, _ := limits.PatientCount(ctx, tx, tenantID)
	users, _ := limits.UserCount(ctx, tx, tenantID)
	branches, _ := limits.BranchCount(ctx, tx, tenantID)
	var oS, oP, oU, oB *int
	_ = tx.QueryRow(ctx,
		`SELECT storage_gb_override, patient_limit_override, user_limit_override, branch_limit_override FROM tenants WHERE id=$1`,
		tenantID).Scan(&oS, &oP, &oU, &oB)
	return &platform.ClinicUsage{
		PlanName: l.PlanName,
		Storage:  usageLine(storage, l.StorageBytes), Patients: usageLine(patients, l.Patients),
		Users: usageLine(users, l.Users), Branches: usageLine(branches, l.Branches),
		StorageGBOverride: oS, PatientLimitOverride: oP, UserLimitOverride: oU, BranchLimitOverride: oB,
	}, nil
}

func usageLine(used int64, cap *int64) platform.UsageLine {
	if cap == nil {
		return platform.UsageLine{Used: used, Limit: -1}
	}
	return platform.UsageLine{Used: used, Limit: *cap}
}

func priceOr0(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "0"
	}
	return s
}

// --- partner leads (referral program) ---

// clip trims and caps a captured field to keep abusive input bounded.
func clip(str string, n int) string {
	str = strings.TrimSpace(str)
	if len(str) > n {
		return str[:n]
	}
	return str
}

// CaptureLead stores a public partner-page sign-up (unauthenticated), on the
// privileged pool (partner_leads is a global, non-tenant table).
func (s *Service) CaptureLead(ctx context.Context, in platform.PartnerLeadInput) error {
	name := clip(in.Name, 120)
	if name == "" {
		return apperr.Validation("your name is required")
	}
	_, err := s.db.Pool.Exec(ctx,
		`INSERT INTO partner_leads (name, phone, email, region, audience, clinics_estimate, goal, source, ip, user_agent)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		name, clip(in.Phone, 40), clip(in.Email, 160), clip(in.Region, 120),
		clip(in.Audience, 40), clip(in.ClinicsEstimate, 20), clip(in.Goal, 1000),
		clip(in.Source, 160), clip(in.IP, 60), clip(in.UserAgent, 400))
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ListPartnerLeads returns captured leads newest-first (admin only).
func (s *Service) ListPartnerLeads(ctx context.Context) ([]platform.PartnerLead, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT id, name, COALESCE(phone,''), COALESCE(email,''), COALESCE(region,''),
		        COALESCE(audience,''), COALESCE(clinics_estimate,''), COALESCE(goal,''),
		        COALESCE(source,''), status, created_at
		 FROM partner_leads ORDER BY created_at DESC LIMIT 1000`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []platform.PartnerLead{}
	for rows.Next() {
		var l platform.PartnerLead
		if e := rows.Scan(&l.ID, &l.Name, &l.Phone, &l.Email, &l.Region, &l.Audience, &l.ClinicsEstimate, &l.Goal, &l.Source, &l.Status, &l.CreatedAt); e != nil {
			return nil, apperr.Internal(e)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// SetLeadStatus updates a lead's workflow status (admin only).
func (s *Service) SetLeadStatus(ctx context.Context, id uuid.UUID, status string) error {
	switch status {
	case "new", "contacted", "signed", "archived":
	default:
		return apperr.Validation("status must be new, contacted, signed, or archived")
	}
	ct, err := s.db.Pool.Exec(ctx, `UPDATE partner_leads SET status=$1, updated_at=now() WHERE id=$2`, status, id)
	if err != nil {
		return apperr.Internal(err)
	}
	if ct.RowsAffected() == 0 {
		return apperr.NotFound("LEAD_NOT_FOUND", "lead not found")
	}
	return nil
}
