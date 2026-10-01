// Package events implements the transactional outbox pattern. Domain events are
// written to event_outbox in the same transaction as the state change; a relay
// (run in the worker) later dispatches them to in-process handlers. The same
// EventBus/Handler interfaces back a RabbitMQ transport later with no change to
// domain or service code (ADR-001 conflict 2).
package events

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// Event is a domain event. Payload holds the JSON-encoded event body.
type Event struct {
	ID            uuid.UUID       `json:"id"`
	TenantID      *uuid.UUID      `json:"tenant_id,omitempty"`
	AggregateType string          `json:"aggregate_type"`
	AggregateID   uuid.UUID       `json:"aggregate_id"`
	EventType     string          `json:"event_type"` // routing key <module>.<aggregate>.<event>
	Payload       json.RawMessage `json:"payload"`
	// ActorID is the signed-in user whose request published the event, and
	// BranchID their active branch. Nil for system events (the worker, migrations).
	ActorID  *uuid.UUID `json:"actor_id,omitempty"`
	BranchID *uuid.UUID `json:"branch_id,omitempty"`
}

// Publisher writes a domain event to the outbox within an existing transaction.
type Publisher interface {
	Publish(ctx context.Context, tx pgx.Tx, tenantID *uuid.UUID, aggregateType string, aggregateID uuid.UUID, eventType string, payload any) error
}

// OutboxPublisher writes events to the event_outbox table.
type OutboxPublisher struct{}

// NewOutboxPublisher constructs an OutboxPublisher.
func NewOutboxPublisher() *OutboxPublisher { return &OutboxPublisher{} }

// Publish inserts the event into event_outbox using the provided transaction,
// guaranteeing the event and the state change commit atomically.
//
// The actor is taken from the request context here, once, rather than asked of
// every caller: the request is the only place it is known, and a parameter each
// module had to remember is exactly how every audit entry came to have none
// (audit D5).
func (OutboxPublisher) Publish(ctx context.Context, tx pgx.Tx, tenantID *uuid.UUID, aggregateType string, aggregateID uuid.UUID, eventType string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var actor, branch *uuid.UUID
	if p, ok := tenancy.PrincipalFromContext(ctx); ok && p != nil && p.UserID != uuid.Nil {
		uid := p.UserID
		actor, branch = &uid, p.ActiveBranchID
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO event_outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload, actor_id, branch_id)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
		tenantID, aggregateType, aggregateID, eventType, string(raw), actor, branch,
	)
	return err
}
