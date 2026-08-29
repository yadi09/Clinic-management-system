\set ON_ERROR_STOP on
BEGIN;
\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

CREATE TEMP TABLE ctx AS
SELECT :tid::uuid AS tid,
       (SELECT id FROM branches WHERE tenant_id=:tid::uuid LIMIT 1) AS branch,
       (SELECT id FROM departments WHERE tenant_id=:tid::uuid AND name='General Practice') AS dept,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='doctor@joy.com') AS doc,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='reception@joy.com') AS recep,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='laboratory@joy.com') AS lab;

CREATE TEMP TABLE enc AS
SELECT e.id, e.patient_id, e.started_at,
       ('x' || substr(md5(e.id::text), 1, 8))::bit(32)::bigint AS seed
FROM encounters e WHERE e.tenant_id=:tid::uuid;

-- ---------- lab: about one visit in three is investigated ----------
CREATE TEMP TABLE labo AS
SELECT md5('lab'||e.id::text)::uuid AS id, e.id AS encounter_id, e.patient_id, e.started_at, e.seed,
       row_number() OVER (ORDER BY e.started_at) AS n
FROM enc e WHERE e.seed % 3 = 0;

INSERT INTO lab_orders (id, tenant_id, order_no, encounter_id, patient_id, provider_id, priority, clinical_note, status, created_by, created_at)
SELECT l.id, c.tid, l.n, l.encounter_id, l.patient_id, c.doc,
       CASE WHEN l.seed % 11 = 0 THEN 'urgent' ELSE 'routine' END,
       'Please correlate with clinical findings.',
       -- the newest few are still moving through the lab, the rest are signed off
       CASE WHEN l.started_at > now() - interval '3 days' AND l.seed % 2 = 0 THEN 'in_process' ELSE 'validated' END,
       c.doc, l.started_at + interval '35 minutes'
FROM ctx c, labo l
WHERE NOT EXISTS (SELECT 1 FROM lab_orders x WHERE x.id = l.id);

INSERT INTO lab_order_items (id, tenant_id, order_id, test_id, sample_no, specimen, status, collected_by, collected_at, resulted_at, validated_at, validated_by, created_at)
SELECT md5('loi'||l.id::text)::uuid, c.tid, l.id, t.id, l.n, t.specimen,
       CASE WHEN o.status='validated' THEN 'validated' ELSE 'in_process' END,
       c.lab, l.started_at + interval '50 minutes',
       CASE WHEN o.status='validated' THEN l.started_at + interval '2 hours' END,
       CASE WHEN o.status='validated' THEN l.started_at + interval '3 hours' END,
       CASE WHEN o.status='validated' THEN c.lab END,
       l.started_at + interval '35 minutes'
FROM ctx c, labo l
JOIN lab_orders o ON o.id = l.id
JOIN LATERAL (SELECT * FROM lab_tests lt WHERE lt.tenant_id=c.tid ORDER BY md5(lt.id::text || l.id::text) LIMIT 1) t ON true
WHERE NOT EXISTS (SELECT 1 FROM lab_order_items x WHERE x.id = md5('loi'||l.id::text)::uuid);

-- results, with a believable spread of normal / high / low / critical
INSERT INTO lab_results (tenant_id, order_item_id, analyte_id, value, flag, created_at)
SELECT c.tid, i.id, a.id,
       round((a.ref_low + ((i.id::text || a.name) IS NOT NULL)::int * 0
             + ((('x'||substr(md5(i.id::text||a.name),1,6))::bit(24)::int % 1000) / 1000.0)
               * (a.ref_high - a.ref_low) * 1.6 - (a.ref_high - a.ref_low) * 0.25)::numeric, 1)::text AS value,
       'normal', i.created_at + interval '2 hours'
FROM ctx c
JOIN lab_order_items i ON i.tenant_id=c.tid
JOIN lab_analytes a ON a.test_id = i.test_id AND a.tenant_id=c.tid
WHERE i.status='validated'
  AND NOT EXISTS (SELECT 1 FROM lab_results x WHERE x.order_item_id=i.id AND x.analyte_id=a.id);

-- flag them against their own reference range, rather than inventing the flag
UPDATE lab_results r SET flag = CASE
    WHEN a.critical_high IS NOT NULL AND r.value::numeric >= a.critical_high THEN 'critical'
    WHEN a.critical_low  IS NOT NULL AND r.value::numeric <= a.critical_low  THEN 'critical'
    WHEN r.value::numeric > a.ref_high THEN 'high'
    WHEN r.value::numeric < a.ref_low  THEN 'low'
    ELSE 'normal' END
FROM lab_analytes a
WHERE a.id = r.analyte_id AND r.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1';

UPDATE lab_order_items i SET critical_flag = true
FROM lab_results r WHERE r.order_item_id = i.id AND r.flag='critical'
  AND i.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1';

COMMIT;
SELECT 'lab orders' k, count(*) FROM lab_orders WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'lab items', count(*) FROM lab_order_items WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT 'results', count(*) FROM lab_results WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL SELECT '  of which abnormal', count(*) FROM lab_results WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' AND flag<>'normal'
UNION ALL SELECT '  of which critical', count(*) FROM lab_results WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' AND flag='critical';
