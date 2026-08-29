\set ON_ERROR_STOP on
BEGIN;
\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

CREATE TEMP TABLE ctx AS
SELECT :tid::uuid AS tid,
       (SELECT id FROM branches WHERE tenant_id=:tid::uuid LIMIT 1) AS branch,
       (SELECT id FROM departments WHERE tenant_id=:tid::uuid AND name='General Practice') AS dept,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='doctor@joy.com') AS doc,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='reception@joy.com') AS recep;

CREATE TEMP TABLE enc AS
SELECT e.id, e.patient_id, e.started_at, ('x'||substr(md5(e.id::text),1,8))::bit(32)::bigint AS seed
FROM encounters e WHERE e.tenant_id=:tid::uuid;

-- every visit: the card fee and the consultation
CREATE TEMP TABLE line AS
SELECT md5('chg'||e.id::text||s.code)::uuid AS id, e.id AS encounter_id, e.patient_id, e.started_at, e.seed,
       s.id AS service_item_id, s.name, s.price, 'consultation'::text AS source
FROM enc e
JOIN service_items s ON s.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' AND s.code IN ('REG','OPD')
UNION ALL
-- the investigations that were ordered
SELECT md5('chgl'||o.id::text)::uuid, o.encounter_id, o.patient_id, e.started_at, e.seed,
       NULL::uuid, 'Laboratory — ' || t.name, t.price, 'lab'
FROM lab_orders o
JOIN enc e ON e.id = o.encounter_id
JOIN lab_order_items i ON i.order_id = o.id
JOIN lab_tests t ON t.id = i.test_id
WHERE o.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
UNION ALL
-- a procedure here and there
SELECT md5('chgp'||e.id::text)::uuid, e.id, e.patient_id, e.started_at, e.seed,
       s.id, s.name, s.price, 'service'
FROM enc e
JOIN LATERAL (SELECT * FROM service_items x WHERE x.tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1'
              AND x.category IN ('procedure','imaging') ORDER BY md5(x.id::text||e.id::text) LIMIT 1) s ON true
WHERE e.seed % 5 = 0;

-- Most visits are paid on the day. A few recent ones are still at the cashier, and a
-- handful of older ones were never collected — that is what debt ageing is for.
CREATE TEMP TABLE priced AS
SELECT l.*,
       CASE
         WHEN l.started_at > now() - interval '2 days' AND l.seed % 3 = 0 THEN 'pending'
         WHEN l.seed % 23 = 0 THEN 'pending'
         WHEN l.seed % 37 = 0 THEN 'waived'
         ELSE 'paid'
       END AS st
FROM line l;

INSERT INTO charges (id, tenant_id, patient_id, encounter_id, service_item_id, source, description,
                     amount, currency, status, payment_method, branch_id, department_id, provider_id,
                     created_by, settled_by, settled_at, receipt_no, waive_reason, created_at)
SELECT p.id, c.tid, p.patient_id, p.encounter_id, p.service_item_id, p.source, p.name,
       p.price, 'ETB', p.st,
       CASE WHEN p.st='paid' THEN (ARRAY['cash','cash','cash','telebirr','cbe'])[1 + (p.seed % 5)] END,
       c.branch, c.dept, c.doc, c.recep,
       CASE WHEN p.st='paid' THEN c.recep END,
       CASE WHEN p.st='paid' THEN p.started_at + interval '15 minutes' END,
       CASE WHEN p.st='paid' THEN (dense_rank() OVER (ORDER BY p.started_at, p.encounter_id))::bigint END,
       CASE WHEN p.st='waived' THEN 'Unable to pay — approved by the administrator' END,
       p.started_at
FROM ctx c, priced p
WHERE NOT EXISTS (SELECT 1 FROM charges x WHERE x.id = p.id);

COMMIT;
SELECT status, count(*), sum(amount)::numeric(12,0) AS etb
FROM charges WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' GROUP BY status ORDER BY 1;
SELECT to_char(settled_at AT TIME ZONE 'Africa/Addis_Ababa','YYYY-MM') AS month,
       count(*) AS payments, sum(amount)::numeric(12,0) AS etb
FROM charges WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1' AND status='paid'
GROUP BY 1 ORDER BY 1;
