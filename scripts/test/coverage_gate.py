#!/usr/bin/env python3
"""The dental coverage gate: is every in-scope route tested, and did coverage drop?

Inputs (written by scripts/test/coverage.sh):
  --routes-all   every route the API registered        ("METHOD /path" per line)
  --routes-hit   every route the regression run served
  --scope        scripts/test/dental-scope.txt          (excluded prefixes + reasons)
  --percent      `go tool covdata percent` output for the merged run
  --baseline     scripts/test/coverage-baseline.txt      (package → minimum %)

Fails (exit 1) when an in-scope route was never called, or when a gated package's
statement coverage fell below its baseline. --update-baseline raises the baseline to
today's numbers (never lowers it): the ratchet only turns one way.
"""
import argparse
import re
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--routes-all", required=True)
ap.add_argument("--routes-hit", required=True)
ap.add_argument("--scope", required=True)
ap.add_argument("--percent", required=True)
ap.add_argument("--baseline", required=True)
ap.add_argument("--update-baseline", action="store_true")
ap.add_argument("--report", help="write the human summary here too")
a = ap.parse_args()

def lines(p):
    try:
        return [l.strip() for l in open(p) if l.strip()]
    except FileNotFoundError:
        return []

excluded = []
for l in lines(a.scope):
    if l.startswith("#"):
        continue
    excluded.append(l.split()[0])

def in_scope(route):
    path = route.split(" ", 1)[1]
    return not any(path == p.rstrip("/") or path.startswith(p if p.endswith("/") else p + "/") or path == p for p in excluded)

all_routes = sorted(set(lines(a.routes_all)))
hit = set(lines(a.routes_hit))
scope = [r for r in all_routes if in_scope(r)]
missing = [r for r in scope if r not in hit]

# Package coverage, merged across unit + integration + API runs.
pct = {}
for l in lines(a.percent):
    m = re.search(r"(github\.com/reicb/clinicsaas/\S+)\s+coverage:\s+([\d.]+)%", l)
    if m:
        pct[m.group(1).replace("github.com/reicb/clinicsaas/", "")] = float(m.group(2))

# Each line: "<package> <minimum>", optionally "slack=<points> # <reason>". Slack is
# for a package whose coverage moves between identical runs (code driven by
# background timers inside the API under test): a drop smaller than the slack is
# timing, not lost tests. It needs a written reason, and the updater keeps both.
baseline, slack, note = {}, {}, {}
for l in lines(a.baseline):
    if l.startswith("#"):
        continue
    body, _, comment = l.partition("#")
    parts = body.split()
    k, v = parts[0], parts[1]
    baseline[k] = float(v)
    for extra in parts[2:]:
        if extra.startswith("slack="):
            slack[k] = float(extra[len("slack="):])
    if comment.strip():
        note[k] = comment.strip()

out = []
w = out.append
w("=== Dental coverage gate ===")
w(f"Routes in scope: {len(scope)} of {len(all_routes)} registered (excluded prefixes: {len(excluded)})")
w(f"Routes exercised: {len(scope) - len(missing)} / {len(scope)}  ({100 * (len(scope) - len(missing)) / max(1, len(scope)):.1f}%)")
if missing:
    w(f"\n✗ {len(missing)} in-scope routes no test calls:")
    for r in missing:
        w(f"   {r}")

drops = []
w("\nStatement coverage of gated packages (unit + integration + API, merged):")
for pkg in sorted(baseline):
    now = pct.get(pkg)
    base = baseline[pkg]
    if now is None:
        w(f"   {pkg:<40} (no data)   baseline {base:5.1f}%  ✗")
        drops.append(pkg)
        continue
    flag = ""
    if now + 0.05 + slack.get(pkg, 0) < base:
        flag = "  ✗ DROPPED"
        drops.append(pkg)
    w(f"   {pkg:<40} {now:5.1f}%   baseline {base:5.1f}%{flag}")

if a.update_baseline:
    new = dict(baseline)
    for pkg in baseline:
        if pkg in pct and pct[pkg] > baseline[pkg]:
            new[pkg] = round(pct[pkg] - 0.05, 1)
    with open(a.baseline, "w") as f:
        f.write("# Minimum statement coverage per package (scripts/test/coverage_gate.py).\n")
        f.write("# Raised by `scripts/test/coverage.sh --update-baseline`; never lowered by hand without a reason.\n")
        for pkg in sorted(new):
            extra = (f" slack={slack[pkg]}" if pkg in slack else "") + (f"  # {note[pkg]}" if pkg in note else "")
            f.write(f"{pkg} {new[pkg]}{extra}\n")
    w("\nbaseline updated (ratchet raised where coverage improved)")

ok = not missing and not drops
w("\nRESULT: " + ("PASS — every in-scope route is tested and no coverage was lost." if ok else
               "FAIL — add tests for the routes above, or restore the lost coverage."))
text = "\n".join(out)
print(text)
if a.report:
    open(a.report, "w").write(text + "\n")
sys.exit(0 if ok else 1)
