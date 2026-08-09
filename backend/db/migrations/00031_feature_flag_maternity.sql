-- +goose Up
-- +goose StatementBegin
-- Allow the new "maternity" module flag (the feature_flags.flag CHECK whitelists
-- flag names). Without this the flag row is rejected and the module can't turn on.
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
  CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr','finance_advanced','maternity'));
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE feature_flags DROP CONSTRAINT feature_flags_flag_check;
ALTER TABLE feature_flags ADD CONSTRAINT feature_flags_flag_check
  CHECK (flag IN ('pharmacy','laboratory','inventory','insurance','telemedicine','hr','finance_advanced'));
-- +goose StatementEnd
