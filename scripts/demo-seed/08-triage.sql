\set ON_ERROR_STOP on
BEGIN;
\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

-- The first pass picked each queue entry's patient with a correlated subquery, which
-- is evaluated against the table as it was BEFORE the statement — so all 35 rows chose
-- from the same pool and some patients were queued twice. Rebuild with an explicit
-- ranking instead, which cannot collide.
DELETE FROM vitals WHERE tenant_id=:tid::uuid AND encounter_id IN
  (SELECT id FROM encounters WHERE tenant_id=:tid::uuid AND queue_entry_id IN
     (SELECT id FROM queue_entries WHERE tenant_id=:tid::uuid AND enqueued_at > date_trunc('day', now())));
DELETE FROM encounters WHERE tenant_id=:tid::uuid AND queue_entry_id IN
  (SELECT id FROM queue_entries WHERE tenant_id=:tid::uuid AND enqueued_at > date_trunc('day', now()));
DELETE FROM queue_entries WHERE tenant_id=:tid::uuid AND enqueued_at > date_trunc('day', now());

CREATE TEMP TABLE ctx AS
SELECT :tid::uuid AS tid,
       (SELECT id FROM branches WHERE tenant_id=:tid::uuid LIMIT 1) AS branch,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='doctor@joy.com') AS doc,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='triage@joy.com') AS nurse,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='reception@joy.com') AS recep;

CREATE TEMP TABLE slot AS
SELECT row_number() OVER (ORDER BY d.name, v.k) AS seq,
       d.id AS dept_id, d.name AS dept, v.k, v.stage, v.state, v.vitals, v.mins
FROM departments d
CROSS JOIN (VALUES
  (1,'triage','waiting',      false, 495),
  (2,'triage','waiting',      false, 510),
  (3,'triage','called',       false, 520),
  (4,'triage','waiting',      true,  460),
  (5,'triage','waiting',      true,  475),
  (6,'with_doctor','waiting', true,  445),
  (7,'with_doctor','in_consult', true, 430)
) AS v(k,stage,state,vitals,mins)
WHERE d.tenant_id=:tid::uuid;

-- one patient per slot, ranked, so distinctness is guaranteed by construction
CREATE TEMP TABLE ranked AS
SELECT row_number() OVER (ORDER BY md5(id::text)) AS rn, id AS patient_id, mrn
FROM patients WHERE tenant_id=:tid::uuid AND mrn LIKE 'JOY-%';

CREATE TEMP TABLE pick AS
SELECT s.*, r.patient_id, r.mrn FROM slot s JOIN ranked r ON r.rn = s.seq;

INSERT INTO queue_entries (id, tenant_id, branch_id, department_id, patient_id, stage, state, priority,
                           assigned_provider_id, enqueued_at, called_at, started_at, created_by)
SELECT md5('tq'||k.seq::text)::uuid, c.tid, c.branch, k.dept_id, k.patient_id, k.stage, k.state,
       CASE WHEN k.dept='Emergency' AND k.k <= 2 THEN 1 ELSE 0 END,
       CASE WHEN k.stage='with_doctor' THEN c.doc END,
       date_trunc('day', now()) + k.mins * interval '1 minute',
       CASE WHEN k.state <> 'waiting' THEN date_trunc('day', now()) + (k.mins + 9) * interval '1 minute' END,
       CASE WHEN k.state = 'in_consult' THEN date_trunc('day', now()) + (k.mins + 15) * interval '1 minute' END,
       c.recep
FROM ctx c, pick k;

INSERT INTO encounters (id, tenant_id, branch_id, department_id, patient_id, queue_entry_id, provider_id,
                        status, started_at, created_at, created_by)
SELECT md5('tenc'||k.seq::text)::uuid, c.tid, c.branch, k.dept_id, k.patient_id,
       md5('tq'||k.seq::text)::uuid,
       CASE WHEN k.stage='with_doctor' THEN c.doc END,
       'open', date_trunc('day', now()) + (k.mins + 10) * interval '1 minute',
       date_trunc('day', now()) + (k.mins + 10) * interval '1 minute', c.nurse
FROM ctx c, pick k WHERE k.vitals;

INSERT INTO vitals (tenant_id, encounter_id, patient_id, systolic, diastolic, pulse, temp_c,
                    resp_rate, spo2, weight_kg, height_cm, notes, recorded_at, recorded_by)
SELECT c.tid, md5('tenc'||k.seq::text)::uuid, k.patient_id,
       108 + (k.seq * 7 % 45), 68 + (k.seq * 5 % 22), 64 + (k.seq * 11 % 36),
       round((36.3 + (k.seq * 3 % 20) / 10.0)::numeric, 1), 15 + (k.seq % 7), 94 + (k.seq % 6),
       round((16 + (k.seq * 13 % 68))::numeric, 1), 102 + (k.seq * 17 % 80),
       (ARRAY['Walked in unaided.','Looks unwell, febrile to touch.','Brought by a relative.',
              'Complains of chest pain — flagged to the doctor.','Stable, no distress.'])[1 + (k.seq % 5)],
       date_trunc('day', now()) + (k.mins + 12) * interval '1 minute', c.nurse
FROM ctx c, pick k WHERE k.vitals;

COMMIT;
SELECT 'patients queued twice today' AS check, count(*) AS n FROM (
  SELECT patient_id FROM queue_entries WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
   AND enqueued_at > date_trunc('day', now()) GROUP BY patient_id HAVING count(*) > 1) x;
SELECT d.name AS department,
       count(*) FILTER (WHERE q.stage='triage' AND NOT EXISTS (
         SELECT 1 FROM vitals vt JOIN encounters e ON e.id=vt.encounter_id WHERE e.queue_entry_id=q.id)) AS awaiting,
       count(*) FILTER (WHERE q.stage='triage' AND EXISTS (
         SELECT 1 FROM vitals vt JOIN encounters e ON e.id=vt.encounter_id WHERE e.queue_entry_id=q.id)) AS ready,
       count(*) FILTER (WHERE q.stage='with_doctor') AS with_doctor
FROM queue_entries q JOIN departments d ON d.id=q.department_id
WHERE q.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' AND q.enqueued_at > date_trunc('day', now())
GROUP BY d.name ORDER BY d.name;
