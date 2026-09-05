// Package entitlements answers one question: what is this clinic paying for?
//
// Three sources, in order of authority:
//
//	tenant_entitlements  one clinic's exception — an add-on sold, or a clinic
//	                     grandfathered so that gating took nothing away
//	plan_features        what the plan includes
//	feature_flags        the clinic's own on/off switch (kernel handles this one
//	                     separately, because it is per branch as well)
//
// The rule that keeps this safe to introduce: a plan with no plan_features rows
// gates nothing. Plans predate this table, and a plan that has never been told
// what it includes must not be read as including nothing — that would silently
// revoke every paid feature from every clinic on it the moment the code shipped.
// Gating begins for a plan when an operator first says what is in it.
package entitlements

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Set is the resolved answer for one clinic. Configured is false when the
// clinic's plan has no feature list, in which case Features is empty and callers
// must fall back to whatever they did before.
type Set struct {
	Configured bool
	Features   map[string]bool
}

// Allows reports whether a feature may be used. An unconfigured plan allows
// everything — the caller's own switch still applies.
func (s Set) Allows(code string) bool {
	if !s.Configured {
		return true
	}
	return s.Features[code]
}

// Effective resolves the clinic's entitlements. The transaction must already
// carry app.tenant_id (tenant_entitlements is RLS-protected).
func Effective(ctx context.Context, tx pgx.Tx, tenantID uuid.UUID) (Set, error) {
	out := Set{Features: map[string]bool{}}
	rows, err := tx.Query(ctx, `
		WITH plan AS (
		    SELECT p.id FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1
		)
		SELECT f.code,
		       coalesce(te.enabled, pf.enabled, false) AS allowed,
		       (SELECT count(*) FROM plan_features x WHERE x.plan_id = (SELECT id FROM plan)) > 0 AS configured
		  FROM features f
		  LEFT JOIN plan_features pf
		         ON pf.plan_id = (SELECT id FROM plan) AND pf.feature = f.code
		  LEFT JOIN tenant_entitlements te
		         ON te.tenant_id = $1 AND te.feature = f.code`, tenantID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		var allowed, configured bool
		if err := rows.Scan(&code, &allowed, &configured); err != nil {
			return out, err
		}
		out.Configured = configured
		out.Features[code] = allowed
	}
	return out, rows.Err()
}

// Apply folds entitlements into a clinic's feature-flag map, which is what every
// gate in the system already reads. An entitled feature with no switch row is on
// (nobody has had a chance to turn it off yet); one that is not entitled is off
// whatever the switch says, so a clinic cannot turn on what it is not paying for.
func Apply(flags map[string]bool, s Set) map[string]bool {
	if !s.Configured {
		return flags
	}
	if flags == nil {
		flags = map[string]bool{}
	}
	for code, allowed := range s.Features {
		if !allowed {
			flags[code] = false
			continue
		}
		if _, switched := flags[code]; !switched {
			flags[code] = true
		}
	}
	return flags
}
