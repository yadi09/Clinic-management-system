-- +goose Up
-- +goose StatementBegin

-- Braces on the anatomical chart. Like a bridge, braces span teeth along one jaw: the
-- item is stored on the first tooth and names the last in bridge_end (the column's
-- meaning is "the other end of the span"). Material: metal or ceramic brackets.
-- Nothing stored changes; the constraints only widen.
ALTER TABLE dental_chart_items DROP CONSTRAINT dental_chart_items_kind_check;
ALTER TABLE dental_chart_items ADD CONSTRAINT dental_chart_items_kind_check
    CHECK (kind IN ('caries','filling','crown','root_canal','extraction','missing','implant','bridge','braces'));
ALTER TABLE dental_chart_items DROP CONSTRAINT dental_chart_items_material_check;
ALTER TABLE dental_chart_items ADD CONSTRAINT dental_chart_items_material_check
    CHECK (material IN ('composite','amalgam','zirconia','pfm','gold','steel','metal','ceramic'));
ALTER TABLE dental_chart_items DROP CONSTRAINT dental_chart_items_check1;
ALTER TABLE dental_chart_items ADD CONSTRAINT dental_chart_items_span_check
    CHECK ((kind IN ('bridge','braces')) = (bridge_end IS NOT NULL));

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Nothing is undone: narrowing the checks would mean deleting braces a dentist
-- recorded. The release before this one ignores an item kind it does not know, so
-- the wider checks are harmless to it.
SELECT 1;
-- +goose StatementEnd
