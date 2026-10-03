package ratelimit_test

import (
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/reicb/clinicsaas/internal/kernel/ratelimit"
)

// inBubble runs f inside a synctest bubble (fake clock, so refill and the 10-minute
// eviction ticker run instantly and deterministically). NewInProcess starts an
// eviction goroutine that never exits by design; when f returns, synctest reports it
// as "blocked goroutines remain". That specific panic is expected and swallowed —
// any assertion failure inside f has already been recorded on t.
func inBubble(t *testing.T, f func(t *testing.T)) {
	t.Helper()
	defer func() {
		if r := recover(); r != nil {
			if msg, ok := r.(string); ok && strings.Contains(msg, "blocked goroutines remain") {
				return
			}
			if err, ok := r.(error); ok && strings.Contains(err.Error(), "blocked goroutines remain") {
				return
			}
			panic(r)
		}
	}()
	synctest.Test(t, f)
}

// Compile-time: InProcess satisfies the Limiter interface the HTTP layer depends on.
var _ ratelimit.Limiter = (*ratelimit.InProcess)(nil)

// Given a fresh key with burst 3, When 4 requests arrive at once, Then exactly the first
// 3 are allowed and the 4th is refused.
func TestREG_KERNEL_RATELIMIT_001_BurstThenRefuse(t *testing.T) {
	inBubble(t, func(t *testing.T) {
		l := ratelimit.NewInProcess(1, 3)
		for i := 0; i < 3; i++ {
			if !l.Allow("k") {
				t.Fatalf("request %d within burst refused", i+1)
			}
		}
		if l.Allow("k") {
			t.Fatal("request beyond burst allowed")
		}
	})
}

// Given one key exhausted, When a different key asks, Then it has its own full bucket.
func TestREG_KERNEL_RATELIMIT_002_KeysHaveSeparateBuckets(t *testing.T) {
	inBubble(t, func(t *testing.T) {
		l := ratelimit.NewInProcess(1, 2)
		l.Allow("a")
		l.Allow("a")
		if l.Allow("a") {
			t.Fatal("key a not exhausted")
		}
		if !l.Allow("b") || !l.Allow("b") {
			t.Fatal("key b was charged for key a's requests")
		}
		if l.Allow("b") {
			t.Fatal("key b exceeded its own burst")
		}
	})
}

// Given an exhausted key at 2 rps, When time passes, Then tokens refill at the configured
// rate (one after 500ms, none before) and never exceed the burst.
func TestREG_KERNEL_RATELIMIT_003_RefillAtConfiguredRate(t *testing.T) {
	inBubble(t, func(t *testing.T) {
		l := ratelimit.NewInProcess(2, 2)
		l.Allow("k")
		l.Allow("k")
		if l.Allow("k") {
			t.Fatal("not exhausted")
		}
		time.Sleep(400 * time.Millisecond)
		if l.Allow("k") {
			t.Fatal("token appeared before 1/rps elapsed")
		}
		time.Sleep(150 * time.Millisecond) // 550ms since exhaustion
		if !l.Allow("k") {
			t.Fatal("token did not refill after 1/rps")
		}
		// A long idle refills only up to burst.
		time.Sleep(time.Minute)
		allowed := 0
		for i := 0; i < 5; i++ {
			if l.Allow("k") {
				allowed++
			}
		}
		if allowed != 2 {
			t.Fatalf("after long idle allowed %d, want burst=2", allowed)
		}
	})
}

// Given a key exhausted on a non-refilling limiter (rps 0), When the key stays idle past
// the 10-minute eviction window, Then its bucket is evicted and it starts fresh; a key
// seen recently is NOT evicted.
func TestREG_KERNEL_RATELIMIT_004_IdleKeysEvicted(t *testing.T) {
	inBubble(t, func(t *testing.T) {
		l := ratelimit.NewInProcess(0, 1)
		if !l.Allow("idle") || l.Allow("idle") {
			t.Fatal("setup: idle key should allow 1 then refuse")
		}
		if !l.Allow("busy") {
			t.Fatal("setup: busy key first request refused")
		}
		// Keep "busy" active every 5 minutes; leave "idle" untouched for 25 minutes.
		for i := 0; i < 5; i++ {
			time.Sleep(5 * time.Minute)
			synctest.Wait()
			if l.Allow("busy") {
				t.Fatalf("busy key (rps 0) was refilled/evicted at minute %d", (i+1)*5)
			}
		}
		if !l.Allow("idle") {
			t.Fatal("idle key was not evicted after > 10 minutes idle")
		}
	})
}

// Given many goroutines hammering one key, When counted, Then exactly burst requests are
// allowed (no race lets extra requests through).
func TestREG_KERNEL_RATELIMIT_005_ConcurrentAllowNeverExceedsBurst(t *testing.T) {
	inBubble(t, func(t *testing.T) {
		l := ratelimit.NewInProcess(0.0001, 10)
		var ok atomic.Int64
		var wg sync.WaitGroup
		for i := 0; i < 100; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if l.Allow("shared") {
					ok.Add(1)
				}
			}()
		}
		wg.Wait()
		if ok.Load() != 10 {
			t.Fatalf("allowed %d concurrent requests, want exactly burst 10", ok.Load())
		}
	})
}
