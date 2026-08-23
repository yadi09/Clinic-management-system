package verifyet

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Resolving is a client whose credential can change while the process is running.
//
// The key is entered in the super-admin console and stored encrypted, so it can be
// added, rotated or removed without a deploy. That means it cannot be read once at
// startup: this looks it up, caches it briefly so a busy cashier desk is not querying
// on every keystroke, and rebuilds the underlying client when it changes.
//
// A saved key always beats the environment variable. The env var remains as a
// fallback for a deployment that prefers to manage secrets that way — and because a
// console that cannot be reached must not be the only way in.
type Resolving struct {
	lookup  func(context.Context) (string, error)
	envKey  string
	baseURL string
	log     *slog.Logger

	mu      sync.Mutex
	current *Client
	key     string
	fetched time.Time
}

// cacheFor is short enough that a rotation takes effect while somebody is still
// looking at the screen, and long enough that the desk is not hammering the database.
const cacheFor = 30 * time.Second

func NewResolving(lookup func(context.Context) (string, error), envKey, baseURL string, log *slog.Logger) *Resolving {
	return &Resolving{lookup: lookup, envKey: envKey, baseURL: baseURL, log: log}
}

func (r *Resolving) client(ctx context.Context) *Client {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.current != nil && time.Since(r.fetched) < cacheFor {
		return r.current
	}
	key := r.envKey
	if r.lookup != nil {
		if saved, err := r.lookup(ctx); err != nil {
			// A database blip must not silently disable verification: keep serving the
			// key we already have and try again after the cache window.
			r.log.Warn("could not read the saved verification key", "err", err)
			if r.current != nil {
				r.fetched = time.Now()
				return r.current
			}
		} else if saved != "" {
			key = saved
		}
	}
	if r.current == nil || key != r.key {
		r.current, r.key = New(key, r.baseURL, r.log), key
	}
	r.fetched = time.Now()
	return r.current
}

func (r *Resolving) Live() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return r.client(ctx).Live()
}

func (r *Resolving) Verify(ctx context.Context, in Request) (*Result, error) {
	return r.client(ctx).Verify(ctx, in)
}

func (r *Resolving) Status(ctx context.Context, requestID string) (*Result, error) {
	return r.client(ctx).Status(ctx, requestID)
}
