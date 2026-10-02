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

### 2026-10-02 (morning) — WSL
- Second notification kind: **patient waiting** — the assigned doctor gets a short pop-up, a chime and a spoken "<name> is waiting for you." Read from the queue itself (stage with_doctor, state waiting, assigned), so every route into a doctor's queue is covered without touching check-in code. Worker pass every 5 s; doctors' screens poll every 10 s. Clears itself when the patient is called or reassigned.
- Migration **00089** (watermark row + partial index `idx_queue_waiting`). Next migration number is **00090**.
- Per-user sound switch in the bell (doctors/dentists only). Live kinds are listed in `LIVE_KINDS` (frontend `kinds.ts`).

### 2026-10-02 (later) — WSL
- Dialog close ✕ is back in the top-right corner app-wide: `.touch-hit` no longer forces `position: relative` on an element that is already `absolute`/`fixed`/`sticky` (`src/styles/index.css`). Also fixes the dental image delete ✕.
- Notifications redesigned: rows lead with the patient name + card, then "Missed visit N of <course>", then the date in both calendars; Unread/Earlier sections in the bell; kind-aware pop-up title. Migration **00088** adds `notifications.data` (structured fields) and makes `patient_id` cascade on delete (e2e cleanups hard-delete patients). Next migration number is **00089**.
- Test data on prod, test account `cure-dental` only: patients `TEST-N1..3` (and their notices). Delete notifications first is no longer needed (cascade), but remove sessions and plans before the patient.

### 2026-10-02 — WSL
- Shipped in-app notifications: the top-bar bell + a sign-in pop-up. v1 kind = dental "missed visit" (to owner, clinic admin, reception, and the course's dentist). Migration **00087** (`notifications`, `notification_watermarks`); backend `internal/notification`; frontend `features/notifications`. Producer runs in the worker every 5 min; notices clear themselves once the visit is rebooked/done.
- Next migration number is **00088**. To add a notification kind, see the `produce` package doc and `href()` in `notification/http/handlers.go`.
- Left alone on purpose (pre-existing): stale sqlc models in 6 modules, the importlint failure in `dental/service/money_integration_test.go`, and the dialog close ✕ drawn at the bottom by `.touch-hit`.

### 2026-09-29 — WSL
- Set up the Windows-side working copy at `C:\Users\Lenovo\Projects\Clinic-management-system` via a direct rsync copy (not a fresh `git clone`) — so it already has full git history and the `origin` remote wired up, no clone step needed there.
- Excluded from that copy (regenerate locally instead): `frontend/node_modules`, `frontend/dist`, `backend/seed` (compiled Linux binary — rebuild with `go build` if you use it), `.history/` (editor local-history clutter, not worth carrying over).
- Gotcha: checking `git status` on that Windows folder *from a WSL terminal* (through `/mnt/c`) falsely shows almost every file as modified — WSL's DrvFs bridge reports all files as mode 777, which Linux git reads as an executable-bit change. Not real. Native Windows git doesn't have this problem — always treat status/diffs from the Windows side as the source of truth for that copy.
- Open item: 8 untracked files under `docs/` (`dental-implementation-plan.html`, `dental-module-audit.html`, `dental-module-status.html`, `dental-scenario-test-report.html`, `dental-worklist.html`, `emergency-remediation-report.html`, `production-readiness-audit.html`, `vps-production-audit.html`) exist identically in both copies but aren't committed yet. Still deciding: commit as permanent project docs, or treat as scratch and drop. Whoever decides first, commit+push (or delete) from one side only, then pull on the other.
- Pending, not yet done: seeding the Windows-side Claude session with the deeper project memory (payments model, RLS gotchas, deploy access, etc.) via the `import-memory` skill. This file only carries short-term operational context, not that.
