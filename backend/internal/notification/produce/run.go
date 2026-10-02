package produce

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// producer is one kind's two steps: write what is new, and clear what is handled.
type producer interface {
	Produce(ctx context.Context) (int, error)
	Resolve(ctx context.Context) (int, error)
}

// run passes a producer on an interval until the context is cancelled: once at
// start, then every tick.
func run(ctx context.Context, p producer, name string, interval time.Duration, log *slog.Logger) {
	pass(ctx, p, name, log)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pass(ctx, p, name, log)
		}
	}
}

// pass runs both steps and never lets a failure escape. The worker's other loops
// (the event relay, SMS sending) share this process, and a panic here must not
// take them down with it. The steps are independent: one failing still runs the
// other.
func pass(ctx context.Context, p producer, name string, log *slog.Logger) {
	defer func() {
		if r := recover(); r != nil {
			log.Error(name+" notifications panicked", "panic", fmt.Sprint(r))
		}
	}()
	if n, err := p.Produce(ctx); err != nil {
		log.Error(name+" notifications failed", "err", err)
	} else if n > 0 {
		log.Info(name+" notifications created", "count", n)
	}
	if n, err := p.Resolve(ctx); err != nil {
		log.Error("clearing handled "+name+" notifications failed", "err", err)
	} else if n > 0 {
		log.Info(name+" notifications cleared", "count", n)
	}
}
