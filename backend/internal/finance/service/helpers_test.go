package service

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
)

// Small helpers every figure on the finance screens passes through. Tested here as
// well as through the API suite so their coverage does not depend on the hour of day
// the suite happens to run at.

func TestMoneyReadsAnEmptyAmountAsZero(t *testing.T) {
	if money("") != "0.00" || money("1500.00") != "1500.00" {
		t.Error("an empty amount is 0.00; any other is kept as the database gave it")
	}
}

func TestTenantAndBranchArguments(t *testing.T) {
	if tenantOf(context.Background()) != uuid.Nil {
		t.Error("no principal, no tenant")
	}
	p := &tenancy.Principal{TenantID: uuid.New()}
	if tenantOf(tenancy.WithPrincipal(context.Background(), p)) != p.TenantID {
		t.Error("tenantOf should read the principal's tenant")
	}
	b := uuid.New()
	if branchArg(nil) != nil || branchArg(&b) != b {
		t.Error("branchArg: nil means all branches, otherwise the branch's id")
	}
}
