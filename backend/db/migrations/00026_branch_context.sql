-- +goose Up
-- +goose StatementBegin
-- Per-branch feature flags. A row with branch_id = NULL is the tenant-wide
-- default (as before); a row with a branch_id overrides one flag for a single
-- branch (e.g. Laboratory enabled at one branch, disabled at another).
-- Resolution is: branch override -> tenant default. The old UNIQUE(tenant_id,flag)
-- is replaced by two partial unique indexes so a default and per-branch rows can
-- coexist for the same flag.
ALTER TABLE feature_flags ADD COLUMN branch_id UUID REFERENCES branches(id);
ALTER TABLE feature_flags DROP CONSTRAINT IF EXISTS feature_flags_tenant_id_flag_key;
CREATE UNIQUE INDEX feature_flags_tenant_flag_default_key ON feature_flags (tenant_id, flag) WHERE branch_id IS NULL;
CREATE UNIQUE INDEX feature_flags_tenant_flag_branch_key ON feature_flags (tenant_id, flag, branch_id) WHERE branch_id IS NOT NULL;
-- +goose StatementEnd

-- +goose StatementBegin
-- Remember the branch a session is working in, so silent refresh and reconnects
-- land the user back on the same branch instead of resetting to the default.
ALTER TABLE sessions ADD COLUMN active_branch_id UUID REFERENCES branches(id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE sessions DROP COLUMN IF EXISTS active_branch_id;
-- +goose StatementEnd

-- +goose StatementBegin
DROP INDEX IF EXISTS feature_flags_tenant_flag_branch_key;
DROP INDEX IF EXISTS feature_flags_tenant_flag_default_key;
ALTER TABLE feature_flags DROP COLUMN IF EXISTS branch_id;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_tenant_id_flag_key UNIQUE (tenant_id, flag);
-- +goose StatementEnd
