\set ON_ERROR_STOP on
BEGIN;
\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

CREATE TEMP TABLE ctx AS
SELECT :tid::uuid AS tid,
       (SELECT id FROM branches WHERE tenant_id=:tid::uuid LIMIT 1) AS branch,
       (SELECT id FROM departments WHERE tenant_id=:tid::uuid AND name='General Practice') AS dept,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='doctor@joy.com') AS doc,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='triage@joy.com') AS nurse,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='reception@joy.com') AS recep,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='laboratory@joy.com') AS lab;

-- One visit per row: which patient, when, and a stable pseudo-random seed.
CREATE TEMP TABLE visit AS
SELECT row_number() OVER () AS n,
       p.id AS patient_id, p.mrn,
       (now() - (g.d || ' days')::interval - ((g.d * 7 % 9) || ' hours')::interval) AS at,
       ('x' || substr(md5(p.mrn || g.d::text), 1, 8))::bit(32)::bigint AS seed
FROM patients p
CROSS JOIN LATERAL (
  SELECT generate_series(2, 88, (7 + (('x'||substr(md5(p.mrn),1,4))::bit(16)::int % 25))) AS d
) g
WHERE p.tenant_id=:tid::uuid AND p.mrn LIKE 'JOY-%';

-- ---------- encounters ----------
INSERT INTO encounters (id, tenant_id, branch_id, department_id, patient_id, provider_id, status, started_at, closed_at, created_at, created_by)
SELECT md5('enc'||v.n||v.mrn)::uuid, c.tid, c.branch, c.dept, v.patient_id, c.doc, 'closed',
       v.at, v.at + interval '25 minutes', v.at, c.doc
FROM ctx c, visit v
WHERE NOT EXISTS (SELECT 1 FROM encounters e WHERE e.id = md5('enc'||v.n||v.mrn)::uuid);

-- ---------- vitals ----------
INSERT INTO vitals (tenant_id, encounter_id, patient_id, systolic, diastolic, pulse, temp_c, resp_rate, spo2, weight_kg, height_cm, recorded_at, recorded_by)
SELECT c.tid, md5('enc'||v.n||v.mrn)::uuid, v.patient_id,
       105 + (v.seed % 45), 65 + (v.seed % 25), 62 + (v.seed % 38),
       round((36.2 + (v.seed % 22) / 10.0)::numeric, 1), 14 + (v.seed % 8), 93 + (v.seed % 7),
       round((14 + (v.seed % 70))::numeric, 1), 100 + (v.seed % 85),
       v.at + interval '5 minutes', c.nurse
FROM ctx c, visit v
WHERE NOT EXISTS (SELECT 1 FROM vitals x WHERE x.encounter_id = md5('enc'||v.n||v.mrn)::uuid);

-- ---------- diagnosis + SOAP note ----------
CREATE TEMP TABLE dxpick AS
SELECT v.n, v.mrn, v.patient_id, v.at, v.seed, dc.id AS catalog_id, dc.category_id, dc.code, dc.name
FROM visit v
JOIN LATERAL (
  SELECT * FROM diagnosis_catalog d WHERE d.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
  ORDER BY md5(d.code || v.mrn || v.n::text) LIMIT 1
) dc ON true;

INSERT INTO diagnoses (tenant_id, encounter_id, patient_id, catalog_id, category_id, code, description, is_primary, created_by, created_at)
SELECT c.tid, md5('enc'||d.n||d.mrn)::uuid, d.patient_id, d.catalog_id, d.category_id, d.code, d.name, true, c.doc, d.at
FROM ctx c, dxpick d
WHERE NOT EXISTS (SELECT 1 FROM diagnoses x WHERE x.encounter_id = md5('enc'||d.n||d.mrn)::uuid);

INSERT INTO clinical_notes (tenant_id, encounter_id, subjective, objective, assessment, plan, status, signed_by, signed_at, created_by, created_at)
SELECT c.tid, md5('enc'||d.n||d.mrn)::uuid,
  (ARRAY['Complains of fever and headache for three days.',
         'Cough and chest tightness since last week, worse at night.',
         'Abdominal pain after meals, no vomiting.',
         'Here for a routine follow-up. Says she feels well.',
         'Generalised weakness and poor appetite for two weeks.',
         'Back pain after lifting at work. No radiation to the legs.'])[1 + (d.seed % 6)],
  'Alert and oriented. Vitals recorded. Chest clear on auscultation, abdomen soft and non-tender.',
  d.name || ' (' || d.code || ')',
  (ARRAY['Started on treatment. Advised fluids and rest. Review in one week if not improving.',
         'Laboratory requested. Symptomatic treatment meanwhile.',
         'Medication continued at the same dose. Counselled on adherence.',
         'Referred for imaging. Return with the result.',
         'Advised on diet and exercise. Follow-up in one month.'])[1 + (d.seed % 5)],
  'signed', c.doc, d.at + interval '30 minutes', c.doc, d.at
FROM ctx c, dxpick d
WHERE NOT EXISTS (SELECT 1 FROM clinical_notes x WHERE x.encounter_id = md5('enc'||d.n||d.mrn)::uuid);

-- ---------- prescriptions on roughly two visits in three ----------
INSERT INTO prescriptions (id, tenant_id, encounter_id, patient_id, status, dispensed_at, created_by, created_at)
SELECT md5('rx'||v.n||v.mrn)::uuid, c.tid, md5('enc'||v.n||v.mrn)::uuid, v.patient_id,
       'active',
       CASE WHEN v.seed % 4 = 0 THEN v.at + interval '50 minutes' END,
       c.doc, v.at + interval '31 minutes'
FROM ctx c, visit v
WHERE v.seed % 3 <> 0
  AND NOT EXISTS (SELECT 1 FROM prescriptions x WHERE x.id = md5('rx'||v.n||v.mrn)::uuid);

-- the prescribing formulary the doctor picks from (drug_catalog), not pharmacy stock
INSERT INTO drug_catalog (tenant_id, name, default_dose, default_frequency, default_duration, default_instructions, is_active)
SELECT c.tid, d.name, '1 tablet', 'twice daily', '5 days', 'After food.', true
FROM ctx c JOIN drugs d ON d.tenant_id=c.tid
WHERE NOT EXISTS (SELECT 1 FROM drug_catalog x WHERE x.tenant_id=c.tid AND x.name=d.name);

INSERT INTO prescription_items (tenant_id, prescription_id, drug_id, drug_name, dose, frequency, duration, instructions)
SELECT c.tid, r.id, dr.id, dr.name,
       (ARRAY['1 tablet','2 tablets','5 ml','1 capsule'])[1 + (('x'||substr(md5(r.id::text),1,4))::bit(16)::int % 4)],
       (ARRAY['once daily','twice daily','three times daily','every 8 hours'])[1 + (('x'||substr(md5(r.id::text||'f'),1,4))::bit(16)::int % 4)],
       (ARRAY['3 days','5 days','7 days','14 days','1 month'])[1 + (('x'||substr(md5(r.id::text||'d'),1,4))::bit(16)::int % 5)],
       'After food.'
FROM ctx c
JOIN prescriptions r ON r.tenant_id=c.tid
JOIN LATERAL (SELECT * FROM drug_catalog d WHERE d.tenant_id=c.tid ORDER BY md5(d.id::text || r.id::text) LIMIT 1) dr ON true
WHERE NOT EXISTS (SELECT 1 FROM prescription_items x WHERE x.prescription_id = r.id);

COMMIT;
SELECT 'encounters' k, count(*) FROM encounters WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'vitals', count(*) FROM vitals WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'diagnoses', count(*) FROM diagnoses WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'notes', count(*) FROM clinical_notes WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'prescriptions', count(*) FROM prescriptions WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'rx items', count(*) FROM prescription_items WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1';
