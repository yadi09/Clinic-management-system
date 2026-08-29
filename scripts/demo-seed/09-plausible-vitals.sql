\set ON_ERROR_STOP on
BEGIN;
\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

-- The seeded vitals were generated per-visit from a hash, so one patient's weight
-- swung from 57 kg to 23 kg between visits and their height changed with it. Fine as
-- filler, wrong the moment a trend line is drawn through it — the panel showed a
-- 30-year-old woman losing 34 kg.
--
-- Vitals now hang off a per-patient baseline (age- and sex-appropriate) with only
-- small visit-to-visit variation, so a trend reads like a person rather than noise.
CREATE TEMP TABLE base AS
SELECT p.id AS patient_id,
       date_part('year', age(p.dob))::int AS age,
       p.gender,
       ('x'||substr(md5(p.id::text),1,6))::bit(24)::int AS h
FROM patients p WHERE p.tenant_id=:tid::uuid AND p.mrn LIKE 'JOY-%';

CREATE TEMP TABLE norm AS
SELECT b.*,
       CASE WHEN b.age < 2  THEN 8 + (b.h % 4)
            WHEN b.age < 12 THEN 14 + (b.h % 18)
            WHEN b.age < 18 THEN 40 + (b.h % 18)
            WHEN b.gender='female' THEN 52 + (b.h % 26)
            ELSE 60 + (b.h % 28) END::numeric AS weight,
       CASE WHEN b.age < 2  THEN 70 + (b.h % 12)
            WHEN b.age < 12 THEN 95 + (b.h % 40)
            WHEN b.age < 18 THEN 150 + (b.h % 18)
            WHEN b.gender='female' THEN 152 + (b.h % 16)
            ELSE 165 + (b.h % 18) END::numeric AS height,
       -- older patients sit a little higher, and a few are hypertensive
       (CASE WHEN b.age > 50 THEN 124 ELSE 112 END + (b.h % 16))::int AS sys,
       (CASE WHEN b.age > 50 THEN 78 ELSE 70 END + (b.h % 11))::int AS dia,
       (CASE WHEN b.age < 12 THEN 92 ELSE 66 END + (b.h % 18))::int AS pulse
FROM base b;

UPDATE vitals v SET
  weight_kg = round(n.weight + ((('x'||substr(md5(v.id::text),1,4))::bit(16)::int % 30) - 15) / 10.0, 1),
  height_cm = n.height,
  systolic  = n.sys + ((('x'||substr(md5(v.id::text||'s'),1,4))::bit(16)::int % 15) - 7),
  diastolic = n.dia + ((('x'||substr(md5(v.id::text||'d'),1,4))::bit(16)::int % 11) - 5),
  pulse     = n.pulse + ((('x'||substr(md5(v.id::text||'p'),1,4))::bit(16)::int % 17) - 8),
  resp_rate = CASE WHEN n.age < 12 THEN 22 ELSE 15 END + (('x'||substr(md5(v.id::text||'r'),1,4))::bit(16)::int % 5),
  spo2      = 96 + (('x'||substr(md5(v.id::text||'o'),1,4))::bit(16)::int % 4),
  temp_c    = round(36.4 + ((('x'||substr(md5(v.id::text||'t'),1,4))::bit(16)::int % 14)) / 10.0, 1)
FROM norm n
WHERE n.patient_id = v.patient_id AND v.tenant_id=:tid::uuid;

-- keep the one acutely unwell patient acutely unwell
UPDATE vitals v
   SET systolic=84, diastolic=52, pulse=126, resp_rate=28, spo2=88, temp_c=39.4
  FROM encounters e JOIN queue_entries q ON q.id=e.queue_entry_id
 WHERE e.id=v.encounter_id AND v.tenant_id=:tid::uuid
   AND q.id=(SELECT q2.id FROM queue_entries q2 JOIN patients p ON p.id=q2.patient_id
             WHERE p.mrn='JOY-0004' AND q2.stage='with_doctor' LIMIT 1);
COMMIT;

SELECT p.mrn, date_part('year', age(p.dob))::int AS age, p.gender,
       min(v.weight_kg) AS min_kg, max(v.weight_kg) AS max_kg,
       min(v.systolic) AS min_sys, max(v.systolic) AS max_sys, count(*) AS readings
FROM vitals v JOIN patients p ON p.id=v.patient_id
WHERE v.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' AND p.mrn IN ('JOY-0023','JOY-0018','JOY-0013')
GROUP BY p.mrn, p.dob, p.gender ORDER BY p.mrn;
