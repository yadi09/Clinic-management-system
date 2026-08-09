// Package limits is the single source of truth for a tenant's effective
// subscription limits and their enforcement. The effective cap for each dimension
// is the per-clinic override when set (negative = unlimited), otherwise the plan's
// value (NULL = unlimited). Everything runs inside the caller's tenant transaction,
// so RLS scopes each read to the caller's own tenant/plan row.
package limits

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

const bytesPerGB int64 = 1 << 30

// Limits is a tenant's effective caps. A nil pointer means "unlimited".
type Limits struct {
	PlanCode         string
	PlanName         string
	StorageBytes     *int64
	Patients         *int64
	Users            *int64
	Branches         *int64
	ImagesPerPatient *int64 // dental images per patient
}

// eff resolves one dimension: override wins (negative → unlimited), else the plan
// value (NULL → unlimited).
func eff(override, plan *int32) *int64 {
	if override != nil {
		if *override < 0 {
			return nil
		}
		v := int64(*override)
		return &v
	}
	if plan == nil {
		return nil
	}
	v := int64(*plan)
	return &v
}

// Effective loads the tenant's plan + overrides and resolves every cap.
func Effective(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (Limits, error) {
	var code, name string
	var pStorage, pPatients, pUsers, pBranches, pImages *int32
	var oStorage, oPatients, oUsers, oBranches *int32
	err := tx.QueryRow(ctx,
		`SELECT p.code, p.name,
		        p.storage_gb, p.patient_limit, p.user_limit, p.branch_limit, p.images_per_patient,
		        t.storage_gb_override, t.patient_limit_override, t.user_limit_override, t.branch_limit_override
		 FROM tenants t JOIN plans p ON p.id = t.plan_id
		 WHERE t.id = $1`, tenantID).Scan(
		&code, &name, &pStorage, &pPatients, &pUsers, &pBranches, &pImages,
		&oStorage, &oPatients, &oUsers, &oBranches)
	if err != nil {
		return Limits{}, err
	}
	l := Limits{
		PlanCode: code, PlanName: name,
		Patients:         eff(oPatients, pPatients),
		Users:            eff(oUsers, pUsers),
		Branches:         eff(oBranches, pBranches),
		ImagesPerPatient: eff(nil, pImages),
	}
	if gb := eff(oStorage, pStorage); gb != nil {
		b := *gb * bytesPerGB
		l.StorageBytes = &b
	}
	return l, nil
}

// UserLimit / BranchLimit expose a single effective cap so the existing user/branch
// gates can keep their own count logic but honour overrides.
func UserLimit(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (*int64, error) {
	l, err := Effective(ctx, tx, tenantID)
	return l.Users, err
}
func BranchLimit(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (*int64, error) {
	l, err := Effective(ctx, tx, tenantID)
	return l.Branches, err
}

// --- usage counts (display + enforcement) ---

func StorageUsed(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx,
		`SELECT coalesce(sum(size_bytes),0)::bigint FROM attachments WHERE tenant_id = $1 AND deleted_at IS NULL`,
		tenantID).Scan(&n)
	return n, err
}
func PatientCount(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx,
		`SELECT count(*)::bigint FROM patients WHERE tenant_id = $1 AND deleted_at IS NULL`, tenantID).Scan(&n)
	return n, err
}
func UserCount(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx,
		`SELECT count(*)::bigint FROM users WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active'`, tenantID).Scan(&n)
	return n, err
}
func BranchCount(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx,
		`SELECT count(*)::bigint FROM branches WHERE tenant_id = $1 AND deleted_at IS NULL`, tenantID).Scan(&n)
	return n, err
}

// --- enforcement gates (403 with an upgrade message on breach) ---

// EnsureStorageRoom blocks a new upload when the tenant is at/over its cap.
func EnsureStorageRoom(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	l, err := Effective(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if l.StorageBytes == nil {
		return nil
	}
	used, err := StorageUsed(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if used >= *l.StorageBytes {
		return apperr.New(http.StatusForbidden, "STORAGE_LIMIT_REACHED",
			"storage is full — delete some files or upgrade your plan to add space")
	}
	return nil
}

// EnsurePatientRoom blocks registering a new patient when the tenant is at its cap.
func EnsurePatientRoom(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) error {
	l, err := Effective(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if l.Patients == nil {
		return nil
	}
	n, err := PatientCount(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if n >= *l.Patients {
		return apperr.New(http.StatusForbidden, "PATIENT_LIMIT_REACHED",
			"your plan's patient limit has been reached — upgrade the plan to register more patients")
	}
	return nil
}

// EnsureImageRoom blocks a new image upload when the patient is at the plan's
// images-per-patient cap (dental).
func EnsureImageRoom(ctx context.Context, tx pgx.Tx, tenantID, patientID uuid.UUID) error {
	l, err := Effective(ctx, tx, tenantID)
	if err != nil {
		return err
	}
	if l.ImagesPerPatient == nil {
		return nil
	}
	var n int64
	if err := tx.QueryRow(ctx,
		`SELECT count(*)::bigint FROM attachments WHERE tenant_id = $1 AND patient_id = $2 AND type = 'image' AND deleted_at IS NULL`,
		tenantID, patientID).Scan(&n); err != nil {
		return err
	}
	if n >= *l.ImagesPerPatient {
		return apperr.New(http.StatusForbidden, "IMAGE_LIMIT_REACHED",
			fmt.Sprintf("this plan allows up to %d images per patient — remove one or upgrade the plan", *l.ImagesPerPatient))
	}
	return nil
}
