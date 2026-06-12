// Package audit writes the immutable, append-only audit trail (FR-AUD-01/02).
// Mutations record an audit entry either directly (e.g. auth events) or via the
// event consumer registered on the outbox relay.
package audit

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/events"
)

// Entry is a single audit record.
type Entry struct {
	TenantID   uuid.UUID
	ActorID    *uuid.UUID
	BranchID   *uuid.UUID
	Action     string
	TargetType string
	TargetID   *uuid.UUID
	Payload    any
	IP         string
}

// Writer persists audit entries. audit_logs is append-only (no update/delete).
type Writer struct {
	db *kerneldb.DB
}

// NewWriter constructs an audit Writer.
func NewWriter(db *kerneldb.DB) *Writer { return &Writer{db: db} }

// Write appends an audit entry within the entry's tenant scope.
func (w *Writer) Write(ctx context.Context, e Entry) error {
	var payload *string
	if e.Payload != nil {
		raw, err := json.Marshal(e.Payload)
		if err != nil {
			return err
		}
		s := string(raw)
		payload = &s
	}
	var ip *string
	if e.IP != "" {
		ip = &e.IP
	}
	return w.db.WithTenantTx(ctx, e.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO audit_logs (tenant_id, actor_id, branch_id, action, target_type, target_id, payload, ip)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
			e.TenantID, e.ActorID, e.BranchID, e.Action, e.TargetType, e.TargetID, payload, ip,
		)
		return err
	})
}

// EventHandler returns an events.Handler that records every dispatched event as
// an audit entry. Register it with Registry.OnAny.
func (w *Writer) EventHandler() events.Handler {
	return func(ctx context.Context, e events.Event) error {
		if e.TenantID == nil {
			return nil // system events without a tenant are not tenant-audited
		}
		return w.Write(ctx, Entry{
			TenantID:   *e.TenantID,
			Action:     e.EventType,
			TargetType: e.AggregateType,
			TargetID:   &e.AggregateID,
			Payload:    e.Payload,
		})
	}
}
