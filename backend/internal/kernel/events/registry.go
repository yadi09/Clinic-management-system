package events

import "context"

// Handler reacts to a dispatched event. Handlers must be idempotent (events are
// delivered at least once) and should open their own tenant-scoped transaction
// for any tenant-owned writes (e.g. via db.WithTenantTx).
type Handler func(ctx context.Context, e Event) error

// Registry maps event types to handlers. Handlers registered with OnAny receive
// every event (used by the audit consumer).
type Registry struct {
	exact    map[string][]Handler
	wildcard []Handler
}

// NewRegistry constructs an empty Registry.
func NewRegistry() *Registry {
	return &Registry{exact: make(map[string][]Handler)}
}

// On subscribes a handler to a specific event type (routing key).
func (r *Registry) On(eventType string, h Handler) {
	r.exact[eventType] = append(r.exact[eventType], h)
}

// OnAny subscribes a handler to all events.
func (r *Registry) OnAny(h Handler) {
	r.wildcard = append(r.wildcard, h)
}

// handlersFor returns the wildcard handlers followed by the exact matches.
func (r *Registry) handlersFor(eventType string) []Handler {
	out := make([]Handler, 0, len(r.wildcard)+len(r.exact[eventType]))
	out = append(out, r.wildcard...)
	out = append(out, r.exact[eventType]...)
	return out
}
