#!/usr/bin/env python3
"""Build the bug tracker page from its data.

    python3 scripts/bugs/build_tracker.py      # docs/bugs/issues.json -> docs/bug-tracker.html

docs/bugs/issues.json is the single source of truth: one entry per bug, in plain
words, with its status. To move a bug along, change its "status" (and "log") there
and rebuild. The page is self-contained: open it straight from disk.

Statuses, in order:
  open       found, held by a known-bug test, nobody working on it
  explained  walked through with the owner; waiting for "yes, that is the problem"
  confirmed  the owner agreed it is a problem (and answered any decision question)
  fixed      code changed; its known-bug test is now a normal passing test
  verified   the owner checked the fix and accepted it
  wontfix    the owner decided the current behaviour is right
"""
import datetime
import html
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "docs", "bugs", "issues.json")
OUT = os.path.join(ROOT, "docs", "bug-tracker.html")

SEV = ["critical", "high", "medium", "low"]
SEV_LABEL = {"critical": "Critical", "high": "High", "medium": "Medium", "low": "Low"}
SEV_MEANS = {
    "critical": "Money lost or created wrongly, a patient-safety risk, or someone reaching data they must not.",
    "high": "Wrong figures, changes nobody can trace, or permission holes inside a clinic.",
    "medium": "Wrong but recoverable, or a screen that misleads about what is real.",
    "low": "Cosmetic, a wrong error message, or a rare edge.",
}
STATUS = ["open", "explained", "confirmed", "fixed", "verified", "wontfix"]
STATUS_LABEL = {
    "open": "Open", "explained": "Explained", "confirmed": "Confirmed",
    "fixed": "Fixed", "verified": "Verified", "wontfix": "Won't fix",
}
DONE = {"verified", "wontfix"}


def esc(s):
    return html.escape(str(s or ""), quote=True)


def card(i, n):
    sev, st = i["severity"], i.get("status", "open")
    tests = "".join(f"<li><code>{esc(t)}</code></li>" for t in i.get("tests", [])) or "<li>No automated test yet: an operational item</li>"
    files = "".join(f"<li><code>{esc(f)}</code></li>" for f in i.get("files", []))
    decision = (f'<div class="decision"><b>Your decision first:</b> {esc(i["decision"])}</div>'
                if i.get("decision") else "")
    log = "".join(f"<li><time>{esc(e.get('date'))}</time> {esc(e.get('note'))}</li>" for e in i.get("log", []))
    search = " ".join(str(i.get(k, "")) for k in ("id", "title", "simple", "example", "who", "area")).lower()
    return f"""
<article class="issue sev-{sev} st-{st}" id="{esc(i['id'])}" data-sev="{sev}" data-status="{st}"
  data-area="{esc(i['area'])}" data-q="{esc(search)}">
  <details>
    <summary>
      <span class="num">{n}</span>
      <span class="sev">{SEV_LABEL[sev]}</span>
      <span class="ttl">{esc(i['title'])}</span>
      <span class="meta"><span class="id">{esc(i['id'])}</span> · {esc(i['area'])} · effort {esc(i.get('effort', '?'))}</span>
      <span class="status">{STATUS_LABEL[st]}</span>
    </summary>
    <div class="body">
      {decision}
      <dl>
        <dt>What happens</dt><dd>{esc(i['simple'])}</dd>
        <dt>In the clinic</dt><dd class="example">{esc(i['example'])}</dd>
        <dt>Why it matters</dt><dd>{esc(i['why'])}</dd>
        <dt>The fix</dt><dd>{esc(i['fix'])}</dd>
        <dt>Who notices</dt><dd>{esc(i['who'])}</dd>
      </dl>
      <div class="tech">
        <details><summary>For the developer: tests and code</summary>
          <p>Tests that prove it (they flip to normal passing tests when fixed):</p><ul>{tests}</ul>
          {f'<p>Where in the code:</p><ul>{files}</ul>' if files else ''}
        </details>
      </div>
      {f'<div class="log"><b>History</b><ul>{log}</ul></div>' if log else ''}
    </div>
  </details>
</article>"""


def main():
    issues = json.load(open(DATA, encoding="utf-8"))
    issues.sort(key=lambda i: (SEV.index(i["severity"]), i.get("order", 999), i["id"]))
    total = len(issues)
    by_sev = {s: sum(1 for i in issues if i["severity"] == s) for s in SEV}
    by_st = {s: sum(1 for i in issues if i.get("status", "open") == s) for s in STATUS}
    done = sum(by_st[s] for s in DONE)
    nxt = next((i for i in issues if i.get("status", "open") not in DONE | {"fixed"}), None)
    areas = sorted({i["area"] for i in issues})
    pct = round(100 * done / total) if total else 0

    sev_cells = "".join(
        f'<button class="tally sev-{s}" data-filter-sev="{s}"><b>{by_sev[s]}</b><span>{SEV_LABEL[s]}</span>'
        f'<small>{esc(SEV_MEANS[s])}</small></button>' for s in SEV)
    st_opts = "".join(f'<option value="{s}">{STATUS_LABEL[s]} ({by_st[s]})</option>' for s in STATUS)
    area_opts = "".join(f'<option value="{esc(a)}">{esc(a)}</option>' for a in areas)
    nxt_html = (f'<a class="next" href="#{esc(nxt["id"])}" data-open="{esc(nxt["id"])}"><span>Next up</span>'
                f'<b>{esc(nxt["title"])}</b><em>{SEV_LABEL[nxt["severity"]]} · {esc(nxt["id"])} · '
                f'{STATUS_LABEL[nxt.get("status", "open")]}</em></a>') if nxt else '<p class="next">Every issue is closed.</p>'
    cards = "".join(card(i, n + 1) for n, i in enumerate(issues))
    built = datetime.datetime.now().strftime("%-d %B %Y, %H:%M")

    page = TEMPLATE.format(
        total=total, done=done, pct=pct, sev_cells=sev_cells, st_opts=st_opts, area_opts=area_opts,
        nxt=nxt_html, cards=cards, built=built,
        fixed=by_st["fixed"], verified=by_st["verified"], confirmed=by_st["confirmed"] + by_st["explained"],
        open=by_st["open"],
    )
    open(OUT, "w", encoding="utf-8").write(page)
    print(f"{OUT}: {total} issues, {done} closed")


TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ClinicOS bug tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Fraunces:opsz,wght@9..144,600&display=swap" rel="stylesheet">
<style>
:root {{
  --paper:#fbfaf7; --card:#ffffff; --ink:#1f2a33; --soft:#5d6b76; --line:#e3e0d8;
  --teal:#0f6e6a; --crit:#b42318; --crit-bg:#fdecea; --high:#b45309; --high-bg:#fdf1e3;
  --med:#2f5d8a; --med-bg:#e8f0f8; --low:#6b7280; --low-bg:#f0f1f3; --ok:#1d7a46; --ok-bg:#e5f4ea;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --paper:#14181c; --card:#1b2026; --ink:#e7e9ea; --soft:#9aa6b0; --line:#2c333a;
  --teal:#4fb3ad; --crit:#f2867c; --crit-bg:#3a1f1d; --high:#f0a85a; --high-bg:#3a2a18;
  --med:#86b3e0; --med-bg:#1c2a38; --low:#a3a9b1; --low-bg:#23282e; --ok:#6cc792; --ok-bg:#1a3325; }} }}
* {{ box-sizing:border-box }}
body {{ margin:0; background:var(--paper); color:var(--ink); font:17px/1.6 "Atkinson Hyperlegible",system-ui,sans-serif }}
.wrap {{ max-width:960px; margin:0 auto; padding:32px 16px 80px }}
h1 {{ font-family:Fraunces,Georgia,serif; font-weight:600; font-size:2.1rem; line-height:1.15; margin:0 0 6px }}
.lede {{ color:var(--soft); max-width:62ch; margin:0 0 24px }}
.progress {{ display:flex; align-items:center; gap:14px; margin:0 0 22px }}
.bar {{ flex:1; height:12px; border-radius:6px; background:var(--line); overflow:hidden }}
.bar i {{ display:block; height:100%; background:var(--ok); width:{pct}% }}
.progress b {{ white-space:nowrap }}
.how {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 20px; margin:0 0 22px }}
.how ol {{ margin:6px 0 0; padding-left:22px }} .how li {{ margin:2px 0 }}
.tallies {{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:0 0 18px }}
.tally {{ text-align:left; font:inherit; color:inherit; background:var(--card); border:1px solid var(--line); border-top:5px solid; border-radius:10px; padding:12px 14px; cursor:pointer }}
.tally b {{ font-size:1.9rem; line-height:1; display:block }} .tally span {{ font-weight:700 }}
.tally small {{ display:block; color:var(--soft); font-size:.8rem; line-height:1.35; margin-top:4px }}
.tally.on {{ outline:3px solid var(--teal); outline-offset:1px }}
.tally.sev-critical {{ border-top-color:var(--crit) }} .tally.sev-high {{ border-top-color:var(--high) }}
.tally.sev-medium {{ border-top-color:var(--med) }} .tally.sev-low {{ border-top-color:var(--low) }}
.next {{ display:block; text-decoration:none; color:inherit; background:var(--card); border:2px solid var(--teal); border-radius:10px; padding:14px 18px; margin:0 0 22px }}
.next span {{ color:var(--teal); font-weight:700; display:block; font-size:.9rem }}
.next b {{ font-size:1.2rem; display:block }} .next em {{ color:var(--soft); font-style:normal; font-size:.9rem }}
.filters {{ display:flex; flex-wrap:wrap; gap:10px; margin:0 0 14px; position:sticky; top:0; background:var(--paper); padding:10px 0; z-index:2 }}
.filters input, .filters select {{ font:inherit; font-size:.95rem; color:var(--ink); background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px }}
.filters input {{ flex:1; min-width:200px }}
.count {{ color:var(--soft); font-size:.9rem; margin:0 0 10px }}
.issue {{ background:var(--card); border:1px solid var(--line); border-left:6px solid; border-radius:10px; margin:0 0 10px }}
.issue.sev-critical {{ border-left-color:var(--crit) }} .issue.sev-high {{ border-left-color:var(--high) }}
.issue.sev-medium {{ border-left-color:var(--med) }} .issue.sev-low {{ border-left-color:var(--low) }}
.issue > details > summary {{ list-style:none; cursor:pointer; padding:12px 16px; display:grid; grid-template-columns:auto auto 1fr auto; gap:4px 12px; align-items:baseline }}
.issue > details > summary::-webkit-details-marker {{ display:none }}
.num {{ color:var(--soft); font-variant-numeric:tabular-nums; min-width:2ch }}
.sev {{ font-size:.78rem; font-weight:700; padding:1px 8px; border-radius:20px }}
.sev-critical .sev {{ color:var(--crit); background:var(--crit-bg) }} .sev-high .sev {{ color:var(--high); background:var(--high-bg) }}
.sev-medium .sev {{ color:var(--med); background:var(--med-bg) }} .sev-low .sev {{ color:var(--low); background:var(--low-bg) }}
.ttl {{ font-weight:700 }}
.meta {{ grid-column:3; color:var(--soft); font-size:.85rem }}
.status {{ grid-row:1; grid-column:4; font-size:.8rem; font-weight:700; padding:2px 10px; border-radius:20px; background:var(--low-bg); color:var(--soft); white-space:nowrap }}
.st-explained .status, .st-confirmed .status {{ background:var(--high-bg); color:var(--high) }}
.st-fixed .status {{ background:var(--med-bg); color:var(--med) }}
.st-verified .status, .st-wontfix .status {{ background:var(--ok-bg); color:var(--ok) }}
.st-verified .ttl, .st-wontfix .ttl {{ text-decoration:line-through; text-decoration-color:var(--soft) }}
.body {{ padding:0 18px 16px 18px; border-top:1px solid var(--line) }}
dl {{ margin:12px 0 0 }} dt {{ font-weight:700; margin-top:10px }} dd {{ margin:2px 0 0; max-width:70ch }}
dd.example {{ background:var(--paper); border-radius:8px; padding:8px 12px; font-style:italic }}
.decision {{ margin:14px 0 0; background:var(--high-bg); border-radius:8px; padding:10px 14px }}
.tech {{ margin-top:14px; font-size:.88rem; color:var(--soft) }} .tech summary {{ cursor:pointer }}
.tech code {{ font-size:.82rem; word-break:break-all }} .tech ul {{ margin:4px 0; padding-left:20px }}
.log {{ margin-top:12px; font-size:.9rem }} .log ul {{ margin:4px 0; padding-left:20px }} .log time {{ color:var(--soft); margin-right:6px }}
.hide {{ display:none }}
footer {{ color:var(--soft); font-size:.85rem; margin-top:30px }}
:focus-visible {{ outline:3px solid var(--teal); outline-offset:2px }}
@media (max-width:640px) {{
  .tallies {{ grid-template-columns:repeat(2,1fr) }} h1 {{ font-size:1.7rem }}
  .issue > details > summary {{ grid-template-columns:auto 1fr; }}
  .num {{ display:none }} .ttl {{ grid-column:1 / -1 }} .meta {{ grid-column:1 / -1 }}
  .status {{ grid-row:auto; grid-column:2; justify-self:end }}
}}
</style></head>
<body><div class="wrap">
<h1>ClinicOS bug tracker</h1>
<p class="lede">Every known problem in the system, in plain words, most urgent first. Each one is already caught by an automated test, so when it is fixed the test proves it, and keeps proving it after every future change.</p>

<div class="progress"><div class="bar"><i></i></div><b>{done} of {total} closed</b></div>

<div class="how"><b>How we work through this list</b>
<ol>
<li><b>Explain:</b> I walk you through the next issue on this page.</li>
<li><b>Confirm:</b> you say it is a real problem (and answer any decision question).</li>
<li><b>Fix:</b> I change the code; its test turns from "known bug" to a normal passing test, and the whole suite must still pass.</li>
<li><b>Verify:</b> you check it and accept it. Then the next one.</li>
</ol>
<p style="margin:8px 0 0;color:var(--soft)">Right now: {open} open · {confirmed} explained or confirmed · {fixed} fixed, waiting for your check · {verified} verified.</p>
</div>

{nxt}

<div class="tallies">{sev_cells}</div>

<div class="filters">
  <input id="q" type="search" placeholder="Search: cashier, follow-up, refund…" aria-label="Search issues">
  <select id="st" aria-label="Status"><option value="">Every status</option><option value="active" selected>Not closed yet</option>{st_opts}</select>
  <select id="ar" aria-label="Area"><option value="">Every area</option>{area_opts}</select>
</div>
<p class="count" id="count"></p>

{cards}

<footer>Built {built} from <code>docs/bugs/issues.json</code> by <code>scripts/bugs/build_tracker.py</code>. Severity says how much harm; the number is the order we fix them in.</footer>
</div>
<script>
(function () {{
  var q = document.getElementById("q"), st = document.getElementById("st"), ar = document.getElementById("ar");
  var items = Array.prototype.slice.call(document.querySelectorAll(".issue"));
  var tallies = Array.prototype.slice.call(document.querySelectorAll("[data-filter-sev]"));
  var sev = "";
  function apply() {{
    var t = q.value.trim().toLowerCase(), s = st.value, a = ar.value, n = 0;
    items.forEach(function (el) {{
      var ds = el.dataset.status, closed = ds === "verified" || ds === "wontfix";
      var ok = (!sev || el.dataset.sev === sev) && (!a || el.dataset.area === a) &&
        (!s || (s === "active" ? !closed : ds === s)) && (!t || el.dataset.q.indexOf(t) >= 0);
      el.classList.toggle("hide", !ok); if (ok) n++;
    }});
    document.getElementById("count").textContent = n + " of " + items.length + " issues shown";
  }}
  tallies.forEach(function (b) {{
    b.addEventListener("click", function () {{
      sev = sev === b.dataset.filterSev ? "" : b.dataset.filterSev;
      tallies.forEach(function (x) {{ x.classList.toggle("on", x.dataset.filterSev === sev); }});
      apply();
    }});
  }});
  [q, st, ar].forEach(function (el) {{ el.addEventListener("input", apply); }});
  function openHash() {{
    var id = decodeURIComponent(location.hash.slice(1)); if (!id) return;
    var el = document.getElementById(id); if (!el) return;
    el.classList.remove("hide"); el.querySelector("details").open = true;
  }}
  window.addEventListener("hashchange", openHash);
  apply(); openHash();
}})();
</script>
</body></html>
"""

if __name__ == "__main__":
    main()
