\set ON_ERROR_STOP on
BEGIN;
\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

CREATE TEMP TABLE ctx AS
SELECT :tid::uuid AS tid,
       (SELECT id FROM branches WHERE tenant_id=:tid::uuid LIMIT 1) AS branch,
       (SELECT id FROM departments WHERE tenant_id=:tid::uuid AND name='General Practice') AS dept,
       (SELECT id FROM departments WHERE tenant_id=:tid::uuid AND name='Internal Medicine') AS dept2,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='doctor@joy.com') AS doc,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='triage@joy.com') AS nurse,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='reception@joy.com') AS recep;

-- ---------- appointments: one clinician, so the slots must not collide ----------
CREATE TEMP TABLE slot AS
SELECT row_number() OVER () AS n, d.off, s.hh,
       ((current_date + d.off)::timestamp AT TIME ZONE 'Africa/Addis_Ababa') + (s.hh || ' minutes')::interval AS starts
FROM generate_series(-14, 14) AS d(off)
CROSS JOIN (VALUES (540),(570),(600),(630),(660),(690)) AS s(hh)   -- 09:00 .. 11:30
WHERE extract(dow FROM current_date + d.off) NOT IN (0);            -- the clinic is closed on Sunday

INSERT INTO appointments (id, tenant_id, branch_id, department_id, patient_id, provider_id,
                          starts_at, ends_at, status, reason, source, created_by, created_at)
SELECT md5('apt'||s.n::text)::uuid, c.tid, c.branch,
       CASE WHEN s.n % 4 = 0 THEN c.dept2 ELSE c.dept END,
       p.id, c.doc, s.starts, s.starts + interval '30 minutes',
       CASE WHEN s.off < 0 THEN (ARRAY['completed','completed','completed','completed','no_show','cancelled'])[1 + (s.n % 6)]
            WHEN s.off = 0 THEN (ARRAY['booked','checked_in','completed','booked'])[1 + (s.n % 4)]
            ELSE 'booked' END,
       (ARRAY['Follow-up','New complaint','Review of results','Blood pressure check','Antenatal visit','Vaccination'])[1 + (s.n % 6)],
       'staff', c.recep, now() - interval '20 days'
FROM ctx c, slot s
JOIN LATERAL (SELECT * FROM patients x WHERE x.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
              AND x.mrn LIKE 'JOY-%' ORDER BY md5(x.id::text || s.n::text) LIMIT 1) p ON true
WHERE NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = md5('apt'||s.n::text)::uuid);

-- ---------- today's queue ----------
INSERT INTO queue_entries (id, tenant_id, branch_id, department_id, patient_id, stage, state, priority,
                           assigned_provider_id, enqueued_at, called_at, started_at, ended_at, created_by)
SELECT md5('q'||v.k::text)::uuid, c.tid, c.branch, c.dept, p.id, v.stage, v.state, v.prio,
       CASE WHEN v.stage='with_doctor' THEN c.doc END,
       date_trunc('day', now()) + v.mins * interval '1 minute',
       CASE WHEN v.state <> 'waiting' THEN date_trunc('day', now()) + (v.mins + 12) * interval '1 minute' END,
       CASE WHEN v.state IN ('in_consult','done') THEN date_trunc('day', now()) + (v.mins + 18) * interval '1 minute' END,
       CASE WHEN v.state = 'done' THEN date_trunc('day', now()) + (v.mins + 40) * interval '1 minute' END,
       c.recep
FROM ctx c, (VALUES
  (1,'triage','waiting',0,505),
  (2,'triage','waiting',1,515),
  (3,'with_doctor','waiting',0,525),
  (4,'with_doctor','called',0,535),
  (5,'with_doctor','in_consult',0,545),
  (6,'with_doctor','done',0,470),
  (7,'with_doctor','done',0,480),
  (8,'triage','done',0,455),
  (9,'with_doctor','waiting',2,555)
) AS v(k,stage,state,prio,mins)
JOIN LATERAL (SELECT * FROM patients x WHERE x.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
              AND x.mrn LIKE 'JOY-%' ORDER BY md5(x.id::text || 'q' || v.k::text) LIMIT 1) p ON true
WHERE NOT EXISTS (SELECT 1 FROM queue_entries q WHERE q.id = md5('q'||v.k::text)::uuid);

-- ---------- the ward ----------
INSERT INTO wards (id, tenant_id, branch_id, name)
SELECT md5('ward'||w.name)::uuid, c.tid, c.branch, w.name FROM ctx c,
  (VALUES ('Medical Ward'),('Maternity Ward')) AS w(name)
WHERE NOT EXISTS (SELECT 1 FROM wards x WHERE x.tenant_id=c.tid AND x.name=w.name);

INSERT INTO beds (id, tenant_id, branch_id, ward_id, label, bed_type, daily_rate)
SELECT md5('bed'||b.ward||b.label)::uuid, c.tid, c.branch, w.id, b.label, b.btype, b.rate
FROM ctx c
CROSS JOIN (VALUES
  ('Medical Ward','M-01','general',450),('Medical Ward','M-02','general',450),
  ('Medical Ward','M-03','general',450),('Medical Ward','M-04','general',450),
  ('Medical Ward','M-05','private',900),('Medical Ward','M-06','private',900),
  ('Medical Ward','ICU-1','icu',2500),('Medical Ward','ICU-2','icu',2500),
  ('Maternity Ward','MAT-01','general',500),('Maternity Ward','MAT-02','general',500),
  ('Maternity Ward','MAT-03','delivery',1200)
) AS b(ward,label,btype,rate)
JOIN wards w ON w.tenant_id=c.tid AND w.name=b.ward
WHERE NOT EXISTS (SELECT 1 FROM beds x WHERE x.tenant_id=c.tid AND x.ward_id=w.id AND lower(x.label)=lower(b.label));

COMMIT;
SELECT 'appointments' k, count(*) FROM appointments WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT '  upcoming', count(*) FROM appointments WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' AND starts_at > now()
UNION ALL SELECT 'queue today', count(*) FROM queue_entries WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'wards', count(*) FROM wards WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'beds', count(*) FROM beds WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1';
