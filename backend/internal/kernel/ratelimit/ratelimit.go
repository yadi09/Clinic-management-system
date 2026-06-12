// Package ratelimit abstracts request rate limiting. The MVP uses an in-process
// per-key token bucket (accurate for a single API instance); a Redis-backed
// limiter can replace it behind this interface once the API scales out
// (ADR-001 conflict 3).
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter decides whether a request keyed by key is allowed.
type Limiter interface {
	Allow(key string) bool
}

type bucket struct {
	lim  *rate.Limiter
	seen time.Time
}

// InProcess is an in-memory per-key token-bucket limiter with idle eviction.
type InProcess struct {
	rps   rate.Limit
	burst int
	mu    sync.Mutex
	keys  map[string]*bucket
}

// NewInProcess constructs an in-process limiter (rps requests/sec, burst peak).
func NewInProcess(rps float64, burst int) *InProcess {
	l := &InProcess{rps: rate.Limit(rps), burst: burst, keys: make(map[string]*bucket)}
	go l.evictLoop()
	return l
}

// Allow reports whether a token is available for key.
func (l *InProcess) Allow(key string) bool {
	l.mu.Lock()
	b, ok := l.keys[key]
	if !ok {
		b = &bucket{lim: rate.NewLimiter(l.rps, l.burst)}
		l.keys[key] = b
	}
	b.seen = time.Now()
	l.mu.Unlock()
	return b.lim.Allow()
}

func (l *InProcess) evictLoop() {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for range t.C {
		cutoff := time.Now().Add(-10 * time.Minute)
		l.mu.Lock()
		for k, b := range l.keys {
			if b.seen.Before(cutoff) {
				delete(l.keys, k)
			}
		}
		l.mu.Unlock()
	}
}
