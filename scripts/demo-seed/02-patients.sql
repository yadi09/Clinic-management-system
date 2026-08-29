\set ON_ERROR_STOP on
BEGIN;
\set tid '''2345f765-62df-45de-9874-59bd55b4b6a1'''

CREATE TEMP TABLE ctx AS
SELECT :tid::uuid AS tid,
       (SELECT id FROM branches WHERE tenant_id=:tid::uuid LIMIT 1) AS branch,
       (SELECT id FROM departments WHERE tenant_id=:tid::uuid AND name='General Practice') AS dept,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='doctor@joy.com') AS doc,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='triage@joy.com') AS nurse,
       (SELECT id FROM users WHERE tenant_id=:tid::uuid AND email='reception@joy.com') AS recep;

-- ---------- 48 patients ----------
INSERT INTO patients (tenant_id, mrn, first_name, last_name, gender, dob, phone, address, blood_group, first_visit_date, created_at)
SELECT c.tid,
       'JOY-' || lpad(v.n::text, 4, '0'),
       v.first, v.last, v.sex,
       (current_date - (v.age * 365 + (v.n * 7) % 360))::date,
       '09' || lpad(((11000000 + v.n * 137717) % 99999999)::text, 8, '0'),
       jsonb_build_object('line', v.addr, 'city', 'Addis Ababa'), v.bg,
       (current_date - ((v.n * 11) % 400))::date,
       now() - ((v.n * 11) % 400) * interval '1 day'
FROM ctx c, (VALUES
 (1,'Abebe','Kebede','male',54,'Bole, Addis Ababa','O+'),
 (2,'Tigist','Haile','female',31,'Yeka, Addis Ababa','A+'),
 (3,'Dawit','Mekonnen','male',27,'Kirkos, Addis Ababa','B+'),
 (4,'Hanna','Girma','female',44,'Lideta, Addis Ababa','O-'),
 (5,'Yonas','Tesfaye','male',38,'Arada, Addis Ababa','AB+'),
 (6,'Selamawit','Bekele','female',23,'Gullele, Addis Ababa','A-'),
 (7,'Mulugeta','Assefa','male',61,'Nifas Silk, Addis Ababa','O+'),
 (8,'Bethlehem','Alemu','female',29,'Bole, Addis Ababa','B-'),
 (9,'Getachew','Wolde','male',47,'Akaki, Addis Ababa','A+'),
 (10,'Meseret','Tadesse','female',35,'Kolfe, Addis Ababa','O+'),
 (11,'Solomon','Desta','male',19,'Yeka, Addis Ababa','B+'),
 (12,'Rahel','Negash','female',26,'Bole, Addis Ababa','AB-'),
 (13,'Tesfaye','Abera','male',72,'Arada, Addis Ababa','O+'),
 (14,'Almaz','Gebre','female',58,'Lideta, Addis Ababa','A+'),
 (15,'Henok','Fikru','male',33,'Kirkos, Addis Ababa','O-'),
 (16,'Sara','Yohannes','female',41,'Bole, Addis Ababa','B+'),
 (17,'Biruk','Melaku','male',8,'Yeka, Addis Ababa','A+'),
 (18,'Lidya','Getahun','female',5,'Gullele, Addis Ababa','O+'),
 (19,'Samuel','Teshome','male',50,'Nifas Silk, Addis Ababa','AB+'),
 (20,'Genet','Worku','female',63,'Kolfe, Addis Ababa','A-'),
 (21,'Kalkidan','Sisay','female',22,'Arada, Addis Ababa','O+'),
 (22,'Eyob','Bogale','male',36,'Bole, Addis Ababa','B+'),
 (23,'Marta','Tilahun','female',30,'Lideta, Addis Ababa','A+'),
 (24,'Robel','Ayele','male',14,'Yeka, Addis Ababa','O+'),
 (25,'Frehiwot','Kassa','female',48,'Kirkos, Addis Ababa','AB-'),
 (26,'Nahom','Endale','male',3,'Bole, Addis Ababa','A+'),
 (27,'Aster','Mamo','female',55,'Akaki, Addis Ababa','O+'),
 (28,'Kidus','Berhanu','male',25,'Gullele, Addis Ababa','B-'),
 (29,'Tsion','Legesse','female',33,'Arada, Addis Ababa','A+'),
 (30,'Abel','Tamiru','male',42,'Kolfe, Addis Ababa','O+'),
 (31,'Meron','Zeleke','female',28,'Bole, Addis Ababa','B+'),
 (32,'Fitsum','Habte','male',66,'Nifas Silk, Addis Ababa','A-'),
 (33,'Bruktawit','Solomon','female',37,'Yeka, Addis Ababa','O+'),
 (34,'Natnael','Amare','male',11,'Lideta, Addis Ababa','AB+'),
 (35,'Rediet','Belay','female',24,'Kirkos, Addis Ababa','A+'),
 (36,'Ermias','Shiferaw','male',45,'Bole, Addis Ababa','O-'),
 (37,'Hiwot','Demissie','female',52,'Arada, Addis Ababa','B+'),
 (38,'Yohannes','Ketema','male',29,'Gullele, Addis Ababa','A+'),
 (39,'Semira','Nuru','female',34,'Akaki, Addis Ababa','O+'),
 (40,'Betelhem','Molla','female',21,'Kolfe, Addis Ababa','AB+'),
 (41,'Mikiyas','Gizaw','male',39,'Yeka, Addis Ababa','B-'),
 (42,'Eden','Abraham','female',27,'Bole, Addis Ababa','A+'),
 (43,'Bereket','Tola','male',57,'Lideta, Addis Ababa','O+'),
 (44,'Sifan','Duguma','female',18,'Nifas Silk, Addis Ababa','B+'),
 (45,'Amanuel','Regassa','male',32,'Kirkos, Addis Ababa','A-'),
 (46,'Kidist','Wondimu','female',46,'Arada, Addis Ababa','O+'),
 (47,'Nardos','Ashenafi','female',25,'Bole, Addis Ababa','AB-'),
 (48,'Girum','Hailu','male',60,'Yeka, Addis Ababa','A+')
) AS v(n,first,last,sex,age,addr,bg)
WHERE NOT EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id=c.tid AND p.mrn='JOY-'||lpad(v.n::text,4,'0'));

-- ---------- allergies on a realistic minority ----------
INSERT INTO allergies (tenant_id, patient_id, substance, reaction, severity, created_by)
SELECT c.tid, p.id, a.name, a.default_reaction, a.default_severity, c.doc
FROM ctx c
JOIN patients p ON p.tenant_id=c.tid AND p.mrn IN ('JOY-0001','JOY-0004','JOY-0013','JOY-0017','JOY-0025','JOY-0032','JOY-0040')
JOIN LATERAL (SELECT * FROM allergen_catalog ac WHERE ac.tenant_id=c.tid
              ORDER BY md5(ac.id::text || p.mrn) LIMIT 1) a ON true
WHERE NOT EXISTS (SELECT 1 FROM allergies x WHERE x.tenant_id=c.tid AND x.patient_id=p.id);

COMMIT;
SELECT count(*) AS patients FROM patients WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1';
SELECT count(*) AS allergies FROM allergies WHERE tenant_id='2345f765-62df-45de-9874-59bd55b4b6a1';
