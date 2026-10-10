-- +goose Up
-- +goose StatementBegin

-- Every clinic's allergy picker starts with the standard names (NEW-KERNEL-ALLERGY-1).
-- Staff chose between "Penicillin", "Penicillins" and "pencillin" for the same thing;
-- the prescribing check now understands all of them, but one spelling per allergy
-- keeps the record readable. Four live clinics had no suggestions at all.
--
-- A clinic's own entries are never touched: a name it already has (in any case) is
-- skipped. The list is allergy.StandardAllergens in kernel/allergy; new clinics get
-- it from provisioning.
INSERT INTO allergen_catalog (tenant_id, name)
SELECT t.id, s.name
  FROM tenants t
 CROSS JOIN (VALUES
    ('Penicillins'),
    ('Cephalosporins'),
    ('Sulfa drugs'),
    ('NSAIDs'),
    ('Aspirin'),
    ('Ibuprofen'),
    ('Diclofenac'),
    ('Paracetamol'),
    ('Macrolides'),
    ('Tetracyclines'),
    ('Fluoroquinolones'),
    ('Metronidazole'),
    ('Codeine'),
    ('Local anaesthetics'),
    ('Lidocaine'),
    ('Articaine'),
    ('Adrenaline'),
    ('Latex'),
    ('Iodine'),
    ('Chlorhexidine'),
    ('Eugenol'),
    ('Acrylic (methacrylate)'),
    ('Nickel'),
    ('Egg'),
    ('Peanuts'),
    ('Shellfish')
 ) AS s(name)
 WHERE t.deleted_at IS NULL
ON CONFLICT (tenant_id, lower(name)) WHERE deleted_at IS NULL DO NOTHING;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- Nothing to undo: once seeded, a standard name cannot be told apart from one a
-- clinic added itself, and deleting it could remove a clinic's own entry.
SELECT 1;
-- +goose StatementEnd
