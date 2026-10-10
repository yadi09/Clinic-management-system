-- +goose Up
-- +goose StatementBegin

-- Bills the patient agreed, at the front desk, to pay today (FEAT-RECEP-1).
--
-- The receptionist can tick an earlier unpaid bill. That does two things the queue
-- already knows how to honour for the registration fee: the patient waits at the
-- cashier until the ticked bills are settled, and then goes to the dentist the
-- receptionist chose. The charge itself is not rewritten (its department and
-- provider belong to the visit it was raised for, and revenue-by-department reads
-- them); a marker says "this one is holding the patient today", and one row per
-- patient per day says where they go once it is cleared.
ALTER TABLE charges
    ADD COLUMN desk_selected_at TIMESTAMPTZ,
    ADD COLUMN desk_selected_by UUID;

CREATE INDEX idx_charges_desk_selected ON charges(tenant_id, patient_id)
    WHERE desk_selected_at IS NOT NULL AND status = 'pending' AND deleted_at IS NULL;

CREATE TABLE reception_routes (
    tenant_id     UUID NOT NULL REFERENCES tenants(id),
    patient_id    UUID NOT NULL REFERENCES patients(id),
    route_date    DATE NOT NULL,
    branch_id     UUID NOT NULL,
    department_id UUID NOT NULL,
    provider_id   UUID,
    to_triage     BOOLEAN NOT NULL DEFAULT false,
    created_by    UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, patient_id, route_date)
);

ALTER TABLE reception_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE reception_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reception_routes
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinic_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON reception_routes TO clinic_app;
  END IF;
END $$;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS reception_routes;
DROP INDEX IF EXISTS idx_charges_desk_selected;
ALTER TABLE charges DROP COLUMN IF EXISTS desk_selected_by;
ALTER TABLE charges DROP COLUMN IF EXISTS desk_selected_at;
-- +goose StatementEnd
