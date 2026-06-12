// Package cache abstracts a key/value cache. The MVP uses an in-process,
// TTL-based implementation; Redis can be slotted in later behind this interface
// when the API runs more than one replica (ADR-001 conflict 3).
package cache

import (
	"context"
	"sync"
	"time"
)

// Cache is a minimal byte-oriented cache.
type Cache interface {
	Get(ctx context.Context, key string) ([]byte, bool)
	Set(ctx context.Context, key string, value []byte, ttl time.Duration)
	Delete(ctx context.Context, key string)
}

type entry struct {
	value     []byte
	expiresAt time.Time
}

// Memory is an in-process cache with lazy expiry.
type Memory struct {
	mu sync.RWMutex
	m  map[string]entry
}

// NewMemory constructs an in-process cache.
func NewMemory() *Memory { return &Memory{m: make(map[string]entry)} }

// Get returns the value and whether it was present and unexpired.
func (c *Memory) Get(_ context.Context, key string) ([]byte, bool) {
	c.mu.RLock()
	e, ok := c.m[key]
	c.mu.RUnlock()
	if !ok || (!e.expiresAt.IsZero() && time.Now().After(e.expiresAt)) {
		if ok {
			c.Delete(context.Background(), key)
		}
		return nil, false
	}
	return e.value, true
}

// Set stores a value with an optional TTL (ttl <= 0 means no expiry).
func (c *Memory) Set(_ context.Context, key string, value []byte, ttl time.Duration) {
	var exp time.Time
	if ttl > 0 {
		exp = time.Now().Add(ttl)
	}
	c.mu.Lock()
	c.m[key] = entry{value: value, expiresAt: exp}
	c.mu.Unlock()
}

// Delete removes a key.
func (c *Memory) Delete(_ context.Context, key string) {
	c.mu.Lock()
	delete(c.m, key)
	c.mu.Unlock()
}
