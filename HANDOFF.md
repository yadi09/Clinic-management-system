# Handoff Log

Shared sync point between the two working environments on this repo:
- **WSL** — this machine, Claude Code via the VS Code extension.
- **Windows** — `C:\Users\Lenovo\Projects\Clinic-management-system`, Claude Desktop's cowork feature.

The two Claude sessions don't share memory (different machines, different paths), but they share this file through ordinary git push/pull. It's a running log, not documentation — keep entries short.

## How to use this

- **Starting work on either side:** `git pull` first, then read the top entry or two below before touching anything.
- **Before switching sides (or ending a session):** commit + push your changes, then append a new entry above the previous one with what changed and anything the other side needs to know before continuing.
- Don't rewrite history here — append only. If something here is stale/done, say so in a new entry rather than editing the old one.

## Log

### 2026-09-29 — WSL
- Set up the Windows-side working copy at `C:\Users\Lenovo\Projects\Clinic-management-system` via a direct rsync copy (not a fresh `git clone`) — so it already has full git history and the `origin` remote wired up, no clone step needed there.
- Excluded from that copy (regenerate locally instead): `frontend/node_modules`, `frontend/dist`, `backend/seed` (compiled Linux binary — rebuild with `go build` if you use it), `.history/` (editor local-history clutter, not worth carrying over).
- Gotcha: checking `git status` on that Windows folder *from a WSL terminal* (through `/mnt/c`) falsely shows almost every file as modified — WSL's DrvFs bridge reports all files as mode 777, which Linux git reads as an executable-bit change. Not real. Native Windows git doesn't have this problem — always treat status/diffs from the Windows side as the source of truth for that copy.
- Open item: 8 untracked files under `docs/` (`dental-implementation-plan.html`, `dental-module-audit.html`, `dental-module-status.html`, `dental-scenario-test-report.html`, `dental-worklist.html`, `emergency-remediation-report.html`, `production-readiness-audit.html`, `vps-production-audit.html`) exist identically in both copies but aren't committed yet. Still deciding: commit as permanent project docs, or treat as scratch and drop. Whoever decides first, commit+push (or delete) from one side only, then pull on the other.
- Pending, not yet done: seeding the Windows-side Claude session with the deeper project memory (payments model, RLS gotchas, deploy access, etc.) via the `import-memory` skill. This file only carries short-term operational context, not that.
