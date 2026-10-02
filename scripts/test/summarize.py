#!/usr/bin/env python3
"""Turn `go test -json` output into a regression report a person can act on.

Reads the JSON stream on stdin. Prints, per regression domain (the REG_<DOMAIN>
part of a test name, or the Go package for older tests): passed, failed, known
bugs, skipped. Then every failure with its file:line and message, and every known
bug still present. Exit code 1 when anything failed, so CI and the runner can gate
on it.

    go test ./... -json | python3 scripts/test/summarize.py --title "Backend"
"""
import argparse
import json
import re
import sys
from collections import defaultdict

ap = argparse.ArgumentParser()
ap.add_argument("--title", default="Go tests")
ap.add_argument("--junit", help="also write a JUnit XML file (for CI test reporters)")
args = ap.parse_args()

out = defaultdict(list)      # (pkg, test) -> output lines
result = {}                  # (pkg, test) -> pass|fail|skip
pkg_fail = {}                # pkg -> output when the package itself failed (build error, TestMain)

for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        continue
    pkg, test, action = ev.get("Package", ""), ev.get("Test"), ev.get("Action")
    if action == "output":
        out[(pkg, test)].append(ev.get("Output", ""))
    elif action in ("pass", "fail", "skip") and test:
        result[(pkg, test)] = action
    elif action == "fail" and not test:
        pkg_fail[pkg] = "".join(out[(pkg, None)])

def domain(pkg, test):
    m = re.match(r"TestREG_([A-Z]+)_", test or "")
    if m:
        return "REG " + m.group(1)
    return pkg.replace("github.com/reicb/clinicsaas/", "")

top = {k: v for k, v in result.items() if "/" not in k[1]}  # count top-level tests, not subtests
stats = defaultdict(lambda: defaultdict(int))
fails, known, skipped = [], [], []
for (pkg, test), res in sorted(top.items()):
    text = "".join(out[(pkg, test)])
    d = domain(pkg, test)
    if res == "skip" and "KNOWN BUG" in text:
        stats[d]["known"] += 1
        m = re.search(r"KNOWN BUG ([\w-]+)[^:]*: (.*)", text)
        known.append((test, m.group(1) if m else "?", (m.group(2) if m else text).strip()[:200]))
    elif res == "skip":
        stats[d]["skip"] += 1
        skipped.append((test, text.strip().splitlines()[-1][:160] if text.strip() else ""))
    elif res == "fail":
        stats[d]["fail"] += 1
        # The interesting lines: "file_test.go:123: message" plus what follows it.
        lines = [l.rstrip() for l in text.splitlines() if l.strip() and not l.startswith(("=== ", "--- "))]
        fails.append((pkg, test, "\n".join(lines[:14])))
    else:
        stats[d]["pass"] += 1

W = 34
print(f"\n=== {args.title} ===")
print(f"{'Area':<{W}} {'pass':>5} {'fail':>5} {'known':>6} {'skip':>5}")
tot = defaultdict(int)
for d in sorted(stats):
    s = stats[d]
    for k in ("pass", "fail", "known", "skip"):
        tot[k] += s[k]
    mark = "  ✗" if s["fail"] else ""
    print(f"{d[:W]:<{W}} {s['pass']:>5} {s['fail']:>5} {s['known']:>6} {s['skip']:>5}{mark}")
print(f"{'TOTAL':<{W}} {tot['pass']:>5} {tot['fail']:>5} {tot['known']:>6} {tot['skip']:>5}")

for pkg, text in pkg_fail.items():
    if not any(p == pkg for p, _, _ in fails):
        print(f"\n✗ PACKAGE FAILED (build error or setup): {pkg}\n{text[-1500:]}")

if fails:
    print(f"\n--- {len(fails)} FAILED — these are regressions until shown otherwise ---")
    for pkg, test, detail in fails:
        print(f"\n✗ {test}  ({pkg.replace('github.com/reicb/clinicsaas/', '')})")
        print("  " + detail.replace("\n", "\n  "))
if known:
    print(f"\n--- {len(known)} KNOWN BUGS still present (catalogued, not blocking) ---")
    for test, bid, what in known:
        print(f"  • {bid:<12} {test}: {what}")

if args.junit:
    import os
    import xml.sax.saxutils as x
    os.makedirs(os.path.dirname(os.path.abspath(args.junit)), exist_ok=True)
    with open(args.junit, "w") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n')
        f.write(f'<testsuite name="{x.escape(args.title)}" tests="{len(top)}" failures="{len(fails)}" skipped="{len(known)+len(skipped)}">\n')
        for (pkg, test), res in sorted(top.items()):
            f.write(f'  <testcase classname="{x.escape(pkg)}" name="{x.escape(test)}">')
            text = "".join(out[(pkg, test)])
            if res == "fail":
                f.write(f'<failure message="failed">{x.escape(text[-4000:])}</failure>')
            elif res == "skip":
                f.write(f'<skipped message="{x.quoteattr(text.strip()[-300:])[1:-1]}"/>')
            f.write("</testcase>\n")
        f.write("</testsuite>\n</testsuites>\n")

sys.exit(1 if fails or pkg_fail else 0)
