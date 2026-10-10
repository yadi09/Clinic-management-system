package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// The words, tones and small helpers the home screen is built from are pure
// functions. They are tested here, not only through the API suite, because the API
// test that produces a long wait (REG-FIN-021) cannot make one in the first hours
// after Addis midnight: the clinic's day is too young to hold a 150-minute wait. The
// coverage of these functions must not depend on the hour the suite is run at.

func TestWaitedIsWordedTheWayAReceptionistSaysIt(t *testing.T) {
	for _, c := range []struct {
		min  int
		want string
	}{
		{0, "0 minutes"}, {1, "1 minute"}, {24, "24 minutes"}, {59, "59 minutes"},
		{60, "over an hour"}, {119, "over an hour"},
		{120, "over 2 hours"}, {150, "over 2 hours"}, {300, "over 5 hours"},
	} {
		if got := waited(c.min); got != c.want {
			t.Errorf("waited(%d) = %q, want %q", c.min, got, c.want)
		}
	}
}

func TestToneAndActionOfAnAlertKind(t *testing.T) {
	tones := map[string]string{
		"unbilled": "danger", "overdue": "danger",
		"shift_variance": "warn", "stalled": "warn", "no_show": "warn", "long_wait": "warn", "missed_visit": "warn",
		"anything_else": "info",
	}
	for kind, want := range tones {
		if got := toneOf(kind); got != want {
			t.Errorf("toneOf(%q) = %q, want %q", kind, got, want)
		}
	}
	// Loudest first: danger, then warn, then everything else.
	if toneRank("danger") >= toneRank("warn") || toneRank("warn") >= toneRank("info") || toneRank("anything") != toneRank("info") {
		t.Errorf("tone ranks out of order: %d %d %d", toneRank("danger"), toneRank("warn"), toneRank("info"))
	}
	actions := map[string]string{
		"unbilled": "Send to cashier", "overdue": "See who owes", "shift_variance": "Review", "long_wait": "Open",
	}
	for kind, want := range actions {
		if got := actionOf(kind); got != want {
			t.Errorf("actionOf(%q) = %q, want %q", kind, got, want)
		}
	}
	if detailOf("unbilled") == "" || detailOf("overdue") == "" || detailOf("shift_variance") == "" || detailOf("long_wait") != "" {
		t.Error("detailOf should explain unbilled, overdue and shift_variance, and say nothing for the rest")
	}
}

func TestSmallFormattingHelpers(t *testing.T) {
	if plural(1, "minute", "minutes") != "1 minute" || plural(0, "minute", "minutes") != "0 minutes" || plural(7, "minute", "minutes") != "7 minutes" {
		t.Error("plural")
	}
	if money("") != "0.00" || money("12.50") != "12.50" {
		t.Error("money: an empty amount reads as 0.00, anything else is kept")
	}
	if num("3.5") != 3.5 || num("not a number") != 0 {
		t.Error("num: unparseable text is zero")
	}
	d := midnight(time.Date(2026, 10, 10, 15, 30, 59, 0, time.UTC))
	if d.Hour() != 0 || d.Minute() != 0 || d.Second() != 0 || d.Day() != 10 {
		t.Errorf("midnight = %v", d)
	}
	if _, off := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC).In(addis()).Zone(); off != 3*60*60 {
		t.Errorf("the clinic's clock is UTC+3, got offset %ds", off)
	}
}

func TestBranchAndTenantFromThePrincipal(t *testing.T) {
	b := uuid.New()
	if branchArg(nil) != nil || branchArg(&b) != b {
		t.Error("branchArg: nil means all branches, otherwise the branch's id")
	}
	if activeBranch(nil) != nil {
		t.Error("no principal means all branches")
	}
	p := &tenancy.Principal{TenantID: uuid.New(), ActiveBranchID: &b, Permissions: []string{"billing.manage", "queue.manage"}}
	if got := activeBranch(p); got == nil || *got != b {
		t.Errorf("activeBranch = %v, want %v", got, b)
	}
	if tenantOf(context.Background()) != uuid.Nil {
		t.Error("no principal, no tenant")
	}
	if tenantOf(tenancy.WithPrincipal(context.Background(), p)) != p.TenantID {
		t.Error("tenantOf should read the principal's tenant")
	}
	if !canSeeMoney(p) || !canSeeFlow(p) {
		t.Error("billing.manage sees money; queue.manage sees the day's flow")
	}
	none := &tenancy.Principal{TenantID: uuid.New()}
	if canSeeMoney(none) || canSeeFlow(none) || canSeeMoney(nil) || canSeeFlow(nil) {
		t.Error("with no permission neither section is shown")
	}
}
