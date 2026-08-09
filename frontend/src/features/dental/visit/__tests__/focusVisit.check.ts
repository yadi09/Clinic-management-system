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

// 3. the patient who came back late
{
  const r = resolveFocus([P("p1","RCT",[S("s1","2026-08-07",1),S("s2","2026-08-20",2)])], T);
  eq("overdue beats upcoming", r.rung, "overdue");
  eq("  ...picks the one waiting longest", r.focus?.session.id, "s1");
}

// 4. two concurrent courses: the other is named, never hidden
{
  const r = resolveFocus([P("p1","RCT",[S("s1",T,1)]), P("p2","Scaling",[S("s2","2026-08-07",1)])], T);
  eq("today wins across plans", r.focus?.session.id, "s1");
  eq("  ...and the overdue other course is surfaced", r.others.map((o) => o.session.id), ["s2"]);
}

// 5. finished course -> the last thing that happened, not an empty page
eq("all done -> last visit",
  resolveFocus([P("p1","RCT",[S("s1","2026-07-01",1,"done"),S("s2","2026-08-01",2,"done")])], T).focus?.session.id, "s2");

// 6. explicit ?visit= always wins
eq("explicit choice wins",
  resolveFocus([P("p1","RCT",[S("s1",T,1),S("s2","2026-09-01",2)])], T, "s2").focus?.session.id, "s2");

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
  eq("most recent overdue wins, not the oldest", r.focus?.session.id, "b1");
}

// 12. "others" lists other COURSES, not siblings already drawn on the rail
{
  const r = resolveFocus([
    P("p1","RCT",[S("s1",T,1),S("s2","2026-09-01",2),S("s3","2026-10-01",3)]),
    P("p2","Scaling",[S("s4","2026-08-20",1),S("s5","2026-08-27",2)]),
  ], T);
  eq("siblings excluded from others", r.others.map((o) => o.session.id), ["s4"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
