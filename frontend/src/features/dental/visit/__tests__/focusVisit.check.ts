import { resolveFocus } from "@/features/dental/visit/useFocusVisit";
const T = "2026-08-12";
let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log("  PASS", name)) : (fail++, console.log("  FAIL", name, "\n     got ", JSON.stringify(got), "\n     want", JSON.stringify(want)));
};
const S = (id: string, date: string, seq: number, status = "planned") =>
  ({ id, seq, scheduled_date: date, amount_due: "2000", status, payment: "unpaid", images: [], prescriptions: [], pay_later: false } as any);
const P = (id: string, title: string, sessions: any[], status = "active") =>
  ({ id, title, total_amount: "12000", start_date: "2026-01-01", interval_unit: "month", interval_count: 1,
     session_count: sessions.length, status, created_at: "", sessions } as any);

// 1. the weekly event: booked today wins over everything
eq("booked today wins",
  resolveFocus([P("p1","RCT",[S("s1","2026-08-01",1,"done"),S("s2",T,2),S("s3","2026-09-01",3)])], T).rung, "today");

// 2. THE BUG THAT STARTED THIS: nothing today, a course running -> must NOT fall to history
{
  const r = resolveFocus([P("p1","RCT",[S("s1","2026-08-01",1,"done"),S("s2","2026-08-20",2)])], T);
  eq("no session today still resolves to the open course", r.rung, "next");
  eq("  ...and names the session", r.focus?.session.id, "s2");
}

// 3. the patient who came back late: the NEXT STEP of the treatment, which is the
//    first visit not done, not the latest missed date
{
  const r = resolveFocus([P("p1","RCT",[S("s1","2026-08-07",1),S("s2","2026-08-20",2)])], T);
  eq("missed beats upcoming", r.rung, "missed");
  eq("  ...picks the next step (first not done)", r.focus?.session.id, "s1");
}

// 4. two concurrent courses: today wins, and both are offered as treatments
{
  const r = resolveFocus([P("p1","RCT",[S("s1",T,1)]), P("p2","Scaling",[S("s2","2026-08-07",1)])], T);
  eq("today wins across plans", r.focus?.session.id, "s1");
  eq("  ...and every treatment in progress is listed", r.treatments.map((t) => t.plan.id), ["p1","p2"]);
  eq("  ...with the other one's missed visit known", r.treatments[1].missed.map((s) => s.id), ["s2"]);
}

// 5. finished course -> the last thing that happened, not an empty page
eq("all done -> last visit",
  resolveFocus([P("p1","RCT",[S("s1","2026-07-01",1,"done"),S("s2","2026-08-01",2,"done")])], T).focus?.session.id, "s2");

// 6. explicit ?visit= always wins, even a done visit
eq("explicit choice wins",
  resolveFocus([P("p1","RCT",[S("s1",T,1),S("s2","2026-09-01",2)])], T, "s2").focus?.session.id, "s2");
eq("explicit choice of a done visit is honoured",
  resolveFocus([P("p1","RCT",[S("s1","2026-08-01",1,"done"),S("s2",T,2)])], T, "s1").rung, "chosen");

// 7. a stale ?visit= must not blank the page
eq("stale id falls back",
  resolveFocus([P("p1","RCT",[S("s1",T,1)])], T, "deleted").rung, "today");

// 8. cancelled plans are not live work
eq("cancelled plan ignored",
  resolveFocus([P("p1","Old",[S("s1",T,1)],"cancelled")], T).rung, "none");

// 9. cancelled session is not an open visit
eq("cancelled session ignored",
  resolveFocus([P("p1","RCT",[S("s1",T,1,"cancelled"),S("s2","2026-09-01",2)])], T).focus?.session.id, "s2");

// 10. no plans at all
eq("no treatment", resolveFocus([], T).rung, "none");

// 11. an abandoned course must not capture the page from a current one
{
  const r = resolveFocus([
    P("old","Abandoned scaling",[S("a1","2026-02-01",1)]),
    P("new","Root canal",[S("b1","2026-08-10",1)]),
  ], T);
  eq("the treatment closest to today wins, not the oldest", r.focus?.session.id, "b1");
}

// 12. the real patient that prompted the redesign: three root canals, two visits
//     missed in the current one, which must open on visit 2 of 5
{
  const t = "2026-10-02";
  const r = resolveFocus([
    P("a","Root canel",[S("a1","2026-08-17",1),S("a2","2026-08-24",2),S("a3","2026-08-24",3,"done")]),
    P("b","Root canel",[S("b1","2026-08-24",1),S("b2","2026-09-07",2),S("b3","2026-10-08",3),S("b4","2026-10-05",4)]),
    P("c","Root canel",[S("c1","2026-08-24",1,"done"),S("c2","2026-09-07",2),S("c3","2026-09-21",3),S("c4","2026-10-05",4),S("c5","2026-10-19",5)]),
  ], t);
  eq("opens the current treatment", r.focus?.plan.id, "c");
  eq("  ...on its next step, visit 2", r.focus?.session.id, "c2");
  eq("  ...as missed", r.rung, "missed");
  eq("  ...numbered 2 of 5", [r.focus?.position, r.focus?.count], [2, 5]);
  eq("  ...knowing visits 2 and 3 were missed", r.treatments.find((x) => x.plan.id === "c")?.missed.map((s) => s.id), ["c2","c3"]);
  eq("  ...and listing all three treatments", r.treatments.length, 3);
}

// 13. numbers follow the calendar, so a moved visit cannot read "1, 3, 2"
{
  const r = resolveFocus([P("p1","RCT",[S("s1","2026-08-01",1,"done"),S("s3","2026-10-08",3),S("s4","2026-10-05",4)])], T);
  eq("next step is the earliest by date", r.focus?.session.id, "s4");
  eq("  ...and is numbered by its place in the calendar", r.focus?.position, 2);
}

// 14. a missed visit recorded today keeps its number: the visit just done must not
//     turn into "visit 3" because the other missed visit's booked day is earlier
{
  const t = "2026-10-02";
  const plans = [P("c","Root canal",[S("c1","2026-08-24",1,"done"),S("c2",t,2,"done"),S("c3","2026-09-21",3),S("c4","2026-10-05",4)])];
  const chosen = resolveFocus(plans, t, "c2");
  eq("the visit just recorded is still visit 2", chosen.focus?.position, 2);
  const r = resolveFocus(plans, t);
  eq("  ...and the next step is the other missed one", r.focus?.session.id, "c3");
  eq("  ...numbered 3", r.focus?.position, 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
