// Stops what global-setup.ts started: SIGTERM to each process group (e2estack stops
// the API on SIGTERM; Vite exits), then SIGKILL anything still standing.
import fs from "node:fs";

import { PIDS_FILE } from "./stack";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export default async function globalTeardown() {
  if (!fs.existsSync(PIDS_FILE)) return;
  const pids = JSON.parse(fs.readFileSync(PIDS_FILE, "utf8")) as number[];
  for (const pid of pids.reverse()) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  }
  const end = Date.now() + 10_000;
  while (Date.now() < end && pids.some(alive)) await new Promise((r) => setTimeout(r, 200));
  for (const pid of pids) {
    if (alive(pid)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  }
  fs.rmSync(PIDS_FILE, { force: true });
}
