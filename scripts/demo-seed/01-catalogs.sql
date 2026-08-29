-- Demo data for Joy Speciality — a general clinic in Addis.
-- Idempotent: every insert is guarded, so re-running tops up rather than duplicates.
\set ON_ERROR_STOP on
BEGIN;

\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

-- who does the work
CREATE TEMP TABLE ctx AS
SELECT :tid::uuid AS tid,
       (SELECT id FROM branches WHERE tenant_id=:tid::uuid LIMIT 1) AS branch,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='doctor@joy.com') AS doc,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='admin@joy.com') AS admin,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='triage@joy.com') AS nurse,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='reception@joy.com') AS recep,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='laboratory@joy.com') AS lab;

-- ---------- departments ----------
INSERT INTO departments (tenant_id, branch_id, name, specialty)
SELECT c.tid, c.branch, d.name, d.spec FROM ctx c,
  (VALUES ('Internal Medicine','internal_medicine'),
          ('Pediatrics','pediatrics'),
          ('Obstetrics & Gynaecology','obgyn'),
          ('Emergency','emergency')) AS d(name,spec)
WHERE NOT EXISTS (SELECT 1 FROM departments x WHERE x.tenant_id=c.tid AND x.name=d.name);

-- ---------- service catalog ----------
INSERT INTO service_items (tenant_id, code, name, category, price, currency, is_active, is_default)
SELECT c.tid, s.code, s.name, s.cat, s.price, 'ETB', true, s.def FROM ctx c,
  (VALUES
    ('REG',  'Registration / card',        'registration', 100, true),
    ('OPD',  'General consultation',       'consultation', 300, true),
    ('SPEC', 'Specialist consultation',    'consultation', 600, false),
    ('FU',   'Follow-up consultation',     'consultation', 200, false),
    ('INJ',  'Injection / IV administration','procedure',   150, false),
    ('DRESS','Wound dressing',             'procedure',    250, false),
    ('SUT',  'Suturing (minor)',           'procedure',    800, false),
    ('NEB',  'Nebulisation',               'procedure',    300, false),
    ('ECG',  'ECG',                        'procedure',    450, false),
    ('USG',  'Ultrasound — abdominal',     'imaging',     1200, false),
    ('USGOB','Ultrasound — obstetric',     'imaging',     1000, false),
    ('ANC',  'Antenatal care visit',       'consultation', 250, false),
    ('FP',   'Family planning counselling','consultation', 150, false),
    ('VAC',  'Childhood vaccination',      'procedure',    200, false),
    ('CERT', 'Medical certificate',        'other',        150, false)
  ) AS s(code,name,cat,price,def)
WHERE NOT EXISTS (SELECT 1 FROM service_items x WHERE x.tenant_id=c.tid AND x.code=s.code);

-- ---------- diagnosis catalog ----------
INSERT INTO diagnosis_categories (tenant_id, name)
SELECT c.tid, n FROM ctx c, (VALUES ('Infectious disease'),('Respiratory'),('Cardiovascular'),
  ('Gastrointestinal'),('Endocrine'),('Obstetric'),('Musculoskeletal'),('Other')) AS v(n)
WHERE NOT EXISTS (SELECT 1 FROM diagnosis_categories x WHERE x.tenant_id=c.tid AND x.name=v.n);

INSERT INTO diagnosis_catalog (tenant_id, category_id, code, name, is_active)
SELECT c.tid, cat.id, d.code, d.name, true FROM ctx c
CROSS JOIN (VALUES
  ('B54','Malaria, unspecified','Infectious disease'),
  ('A09','Acute gastroenteritis','Gastrointestinal'),
  ('J06.9','Upper respiratory tract infection','Respiratory'),
  ('J18.9','Community-acquired pneumonia','Respiratory'),
  ('J45','Asthma','Respiratory'),
  ('I10','Essential hypertension','Cardiovascular'),
  ('E11','Type 2 diabetes mellitus','Endocrine'),
  ('K29','Gastritis','Gastrointestinal'),
  ('N39.0','Urinary tract infection','Infectious disease'),
  ('D50','Iron deficiency anaemia','Other'),
  ('A15','Pulmonary tuberculosis','Infectious disease'),
  ('M54.5','Low back pain','Musculoskeletal'),
  ('Z34','Supervision of normal pregnancy','Obstetric'),
  ('B15','Acute hepatitis A','Gastrointestinal'),
  ('L03','Cellulitis','Other')
) AS d(code,name,cat)
JOIN diagnosis_categories cat ON cat.tenant_id=c.tid AND cat.name=d.cat
WHERE NOT EXISTS (SELECT 1 FROM diagnosis_catalog x WHERE x.tenant_id=c.tid AND x.code=d.code);

-- ---------- allergens ----------
INSERT INTO allergen_catalog (tenant_id, name, default_reaction, default_severity, is_active)
SELECT c.tid, a.n, a.r, a.s, true FROM ctx c, (VALUES
  ('Penicillin','Rash and swelling','severe'),
  ('Sulfa drugs','Rash','moderate'),
  ('Aspirin','Wheezing','moderate'),
  ('Iodine / contrast','Hives','severe'),
  ('Peanuts','Anaphylaxis','severe'),
  ('Dust','Sneezing, watery eyes','mild')
) AS a(n,r,s)
WHERE NOT EXISTS (SELECT 1 FROM allergen_catalog x WHERE x.tenant_id=c.tid AND x.name=a.n);

-- ---------- laboratory ----------
INSERT INTO lab_tests (tenant_id, code, name, specimen, price, is_active)
SELECT c.tid, t.code, t.name, t.spec, t.price, true FROM ctx c, (VALUES
  ('CBC','Complete blood count','Blood',350),
  ('BF','Blood film for malaria','Blood',150),
  ('FBS','Fasting blood sugar','Blood',120),
  ('RFT','Renal function test','Blood',600),
  ('LFT','Liver function test','Blood',700),
  ('UA','Urinalysis','Urine',180),
  ('STOOL','Stool examination','Stool',150),
  ('HGB','Haemoglobin','Blood',100),
  ('WIDAL','Widal test','Blood',250),
  ('HBSAG','Hepatitis B surface antigen','Blood',300)
) AS t(code,name,spec,price)
WHERE NOT EXISTS (SELECT 1 FROM lab_tests x WHERE x.tenant_id=c.tid AND x.code=t.code);

INSERT INTO lab_analytes (tenant_id, test_id, name, unit, ref_low, ref_high, critical_low, critical_high, sort_order)
SELECT c.tid, lt.id, a.an, a.unit, a.lo, a.hi, a.clo, a.chi, a.ord FROM ctx c
CROSS JOIN (VALUES
  ('CBC','WBC','10^3/uL',4.0::numeric,11.0::numeric,1.5::numeric,30.0::numeric,1),
  ('CBC','Haemoglobin','g/dL',12.0,16.0,7.0,20.0,2),
  ('CBC','Platelets','10^3/uL',150,450,50,1000,3),
  ('FBS','Glucose','mg/dL',70,110,40,400,1),
  ('RFT','Creatinine','mg/dL',0.6,1.3,NULL::numeric,5.0,1),
  ('RFT','Urea','mg/dL',15,45,NULL::numeric,150,2),
  ('LFT','ALT','U/L',7,56,NULL::numeric,500,1),
  ('LFT','AST','U/L',10,40,NULL::numeric,500,2),
  ('HGB','Haemoglobin','g/dL',12.0,16.0,7.0,20.0,1)
) AS a(tcode,an,unit,lo,hi,clo,chi,ord)
JOIN lab_tests lt ON lt.tenant_id=c.tid AND lt.code=a.tcode
WHERE NOT EXISTS (SELECT 1 FROM lab_analytes x WHERE x.tenant_id=c.tid AND x.test_id=lt.id AND x.name=a.an);

-- ---------- pharmacy / inventory ----------
INSERT INTO drugs (tenant_id, name, form, drug_class, unit_price, reorder_level, is_active)
SELECT c.tid, d.n, d.f, d.cl, d.p, d.r, true FROM ctx c, (VALUES
  ('Amoxicillin 500mg','Capsule','Antibiotic',8,200),
  ('Paracetamol 500mg','Tablet','Analgesic',2,500),
  ('Ibuprofen 400mg','Tablet','NSAID',3,300),
  ('Metronidazole 400mg','Tablet','Antibiotic',4,200),
  ('Ciprofloxacin 500mg','Tablet','Antibiotic',9,150),
  ('Artemether/Lumefantrine','Tablet','Antimalarial',35,100),
  ('ORS sachet','Sachet','Rehydration',12,150),
  ('Amlodipine 5mg','Tablet','Antihypertensive',5,200),
  ('Metformin 500mg','Tablet','Antidiabetic',4,250),
  ('Salbutamol inhaler','Inhaler','Bronchodilator',180,40),
  ('Ferrous sulphate','Tablet','Haematinic',3,300),
  ('Omeprazole 20mg','Capsule','PPI',6,200)
) AS d(n,f,cl,p,r)
WHERE NOT EXISTS (SELECT 1 FROM drugs x WHERE x.tenant_id=c.tid AND x.name=d.n);

COMMIT;
SELECT 'departments' k, count(*) FROM departments WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'services', count(*) FROM service_items WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'diagnoses catalog', count(*) FROM diagnosis_catalog WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'lab tests', count(*) FROM lab_tests WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'analytes', count(*) FROM lab_analytes WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'drugs', count(*) FROM drugs WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'allergens', count(*) FROM allergen_catalog WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1';
