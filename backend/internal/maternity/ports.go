// Package maternity is the per-clinic-gated pregnancy-dating surface: it persists
// and audits a patient's dating and exposes preview/save/get/history, delegating
// all obstetric math to the pure internal/pregnancy package.
package maternity

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/pregnancy"
)

// Dating is a patient's current dating plus its result recomputed for a date.
type Dating struct {
	Method    pregnancy.Method `json:"method"`
	Result    pregnancy.Result `json:"result"`
	UpdatedAt *time.Time       `json:"updatedAt,omitempty"`
}

// RedateRec flags that a newly-saved dating crossed the ACOG redating threshold
// versus the prior dating — surfaced to the clinician, never applied silently.
type RedateRec struct {
	Recommended     bool      `json:"recommended"`
	DiscrepancyDays int       `json:"discrepancyDays"`
	PreviousEDD     time.Time `json:"previousEdd"`
	NewEDD          time.Time `json:"newEdd"`
}

// SaveResult is the outcome of persisting a dating.
type SaveResult struct {
	Dating Dating     `json:"dating"`
	Redate *RedateRec `json:"redate,omitempty"`
}

// HistoryEntry is one row of the append-only dating history.
type HistoryEntry struct {
	Method         pregnancy.Method `json:"method"`
	CalculatedLMP  time.Time        `json:"calculatedLmp"`
	EDD            time.Time        `json:"edd"`
	RecordedByName string           `json:"recordedByName,omitempty"`
	RecordedAt     time.Time        `json:"recordedAt"`
	Note           string           `json:"note,omitempty"`
}

// Service is the maternity API.
type Service interface {
	// Preview computes a dating without persisting (live UI).
	Preview(ctx context.Context, method pregnancy.Method, in pregnancy.Inputs, gaDate time.Time) (pregnancy.Result, error)
	// SummaryFor returns the current dating for each of the given patients that has
	// one, keyed by patient — for worklists that must show whether dating exists.
	SummaryFor(ctx context.Context, patientIDs []uuid.UUID, gaDate time.Time) (map[uuid.UUID]Dating, error)
	// GetDating returns the patient's current dating (nil if none), GA recomputed for gaDate.
	GetDating(ctx context.Context, patientID uuid.UUID, gaDate time.Time) (*Dating, error)
	// SaveDating computes, upserts the current dating and appends a history row in one tx.
	SaveDating(ctx context.Context, patientID uuid.UUID, method pregnancy.Method, in pregnancy.Inputs, gaDate time.Time, note string) (*SaveResult, error)
	History(ctx context.Context, patientID uuid.UUID) ([]HistoryEntry, error)
}
