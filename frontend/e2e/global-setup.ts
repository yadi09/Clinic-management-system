// Starts the e2e stack: the Go program backend/tests/e2estack (test DB guard,
// one dental clinic, the real API as clinic_app) and then Vite proxying /api to it.
// PIDs go to e2e/.run/pids.json for global-teardown.ts.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { E2E_PORT } from "../playwright.config";
import { PIDS_FILE, RUN_DIR, STACK_FILE, type Stack } from "./stack";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.resolve(FRONTEND, "..", "backend");
const DEFAULT_DB = "postgres://postgres@127.0.0.1:55433/clinic_regress?sslmode=disable";

function waitForLine(p: ChildProcess, re: RegExp, what: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`${what} not ready in ${ms / 1000}s:\n${buf.slice(-4000)}`)), ms);
    const on = (d: Buffer) => {
      buf += d.toString();
      if (re.test(buf)) { clearTimeout(timer); resolve(); }
    };
    p.stdout?.on("data", on);
    p.stderr?.on("data", on);
    p.on("exit", (code) => { clearTimeout(timer); reject(new Error(`${what} exited (${code}):\n${buf.slice(-4000)}`)); });
  });
}

async function waitForHTTP(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not answer in ${ms / 1000}s`);
}

export default async function globalSetup() {
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });

  // Build first, then run the binary: signals then reach e2estack itself (go run
  // would sit in between), so SIGTERM stops the API cleanly.
  const bin = path.join(RUN_DIR, "e2estack");
  execFileSync("go", ["build", "-o", bin, "./tests/e2estack"], { cwd: BACKEND, stdio: "inherit" });

  const stackProc = spawn(bin, ["-out", STACK_FILE], {
    cwd: BACKEND,
    env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL || DEFAULT_DB },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const pids: number[] = [stackProc.pid!];
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  await waitForLine(stackProc, /^READY$/m, "e2estack (API + test clinic)", 240_000);
  const st = JSON.parse(fs.readFileSync(STACK_FILE, "utf8")) as Stack;
  const apiOrigin = new URL(st.apiBase).origin;

  const vite = spawn("npx", ["vite", "--port", String(E2E_PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: FRONTEND,
    env: { ...process.env, VITE_API_PROXY_TARGET: apiOrigin },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  pids.push(vite.pid!);
  fs.writeFileSync(PIDS_FILE, JSON.stringify(pids));
  await waitForHTTP(`http://127.0.0.1:${E2E_PORT}/login`, 120_000);

  // Children are detached (own process group) so teardown can stop each whole tree;
  // drop our handles so Playwright's process does not wait on their pipes.
  stackProc.stdout?.resume(); stackProc.stderr?.resume();
  vite.stdout?.resume(); vite.stderr?.resume();
  stackProc.unref(); vite.unref();
}
