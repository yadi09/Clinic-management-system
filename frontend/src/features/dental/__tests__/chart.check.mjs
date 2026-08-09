// Fake-clock simulation of the odontogram save, transcribed from DentalWorkspace.
// The point is the interleavings the reviewer proved were broken before.
function makeChart({ saveLatency = 200, failAt = null } = {}) {
  let now = 0, screen = {}, server = {};
  const draft = { c: {} }, confirmed = { c: {} }, queued = { c: null }, timer = { c: null };
  const sentSeq = { c: 0 }, ackSeq = { c: 0 };
  const events = [];
  const at = (t, fn) => events.push([t, fn]);
  const show = (m) => { draft.c = m; screen = m; };
  const cycle = ["", "healthy", "decayed", "filled", "extracted", "crown"];

  const send = (map, seq) => {
    const fails = failAt !== null && seq === failAt;
    at(now + saveLatency, () => {
      if (fails) {
        if (timer.c !== null) { timer.c = null; }
        queued.c = null; show(confirmed.c);
        return;
      }
      server = map;
      if (seq < ackSeq.c) return;
      ackSeq.c = seq; confirmed.c = map;
      if (timer.c === null) queued.c = null;
      // invalidate -> refetch lands later, re-seeding only if nothing outstanding
      at(now + 100, () => {
        confirmed.c = server;
        if (queued.c === null) show(server);
      });
    });
  };
  const click = (code) => {
    const nxt = cycle[(cycle.indexOf(draft.c[code] ?? "") + 1) % cycle.length];
    const map = { ...draft.c }; if (nxt) map[code] = nxt; else delete map[code];
    show(map); queued.c = map;
    if (timer.c !== null) timer.c = null;
    const my = { cancelled: false }; timer.c = my;
    at(now + 700, () => {
      if (timer.c !== my) return;      // superseded by a later click
      timer.c = null;
      const s = queued.c; if (s) send(s, ++sentSeq.c);
    });
  };
  const run = (script) => {
    for (const [t, fn] of script) at(t, fn === "click" ? null : fn);
    // drive the clock
    const all = [];
    const push = (t, fn) => all.push([t, fn]);
    return { push };
  };
  return { click, at, get screen() { return screen; }, get server() { return server; },
           tick: (t) => { now = t; const due = events.filter(([x]) => x <= t); 
             for (const e of due) { events.splice(events.indexOf(e), 1); e[1] && e[1](); } } };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let pass = 0, fail = 0;
const check = (name, got, want) => (eq(got, want) ? (pass++, console.log("  PASS", name))
  : (fail++, console.log("  FAIL", name, "\n    got ", JSON.stringify(got), "\n    want", JSON.stringify(want))));

// 1. THE REGRESSION: click, save lands, click again mid-flight -> second tooth survives
{
  const c = makeChart({ saveLatency: 200 });
  c.click("LR6");                       // t=0
  for (let t = 0; t <= 700; t += 50) c.tick(t);   // debounce fires ~700, save sent
  c.click("UR1");                       // t=750, while save A in flight
  for (let t = 750; t <= 2200; t += 50) c.tick(t);
  check("edit during in-flight save survives", c.screen, { LR6: "healthy", UR1: "healthy" });
  check("  ...and reaches the server", c.server, { LR6: "healthy", UR1: "healthy" });
}

// 2. failed save reverts to what the SERVER confirmed, not a mid-burst snapshot
{
  const c = makeChart({ saveLatency: 200, failAt: 1 });
  c.click("UR1"); c.tick(200); c.click("UR1");    // two clicks in one burst
  for (let t = 200; t <= 2000; t += 50) c.tick(t);
  check("failed save reverts to server state", c.screen, {});
  check("  ...server never got the edit", c.server, {});
}

// 3. a quiet burst collapses to one save with the final state
{
  const c = makeChart({ saveLatency: 100 });
  c.click("UR1"); c.tick(100); c.click("UL2"); c.tick(200); c.click("LL3");
  for (let t = 200; t <= 1600; t += 50) c.tick(t);
  check("burst saves the final map", c.server, { UR1: "healthy", UL2: "healthy", LL3: "healthy" });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
