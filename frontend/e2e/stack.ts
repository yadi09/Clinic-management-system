// What globalSetup hands the specs: the provisioned clinic and how to reach its API.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUN_DIR = path.join(HERE, ".run");
export const STACK_FILE = path.join(RUN_DIR, "stack.json");
export const PIDS_FILE = path.join(RUN_DIR, "pids.json");

export interface Stack {
  apiBase: string; // e.g. http://127.0.0.1:41234/api/v1
  slug: string;
  ownerEmail: string;
  staff: Record<string, string>; // receptionist, doctor, nurse, cashier, branch_manager
  password: string;
  platformEmail: string; // a super-admin, for specs that need the vendor console
}

export function stack(): Stack {
  return JSON.parse(fs.readFileSync(STACK_FILE, "utf8")) as Stack;
}

export function emailFor(role: string): string {
  const s = stack();
  if (role === "owner") return s.ownerEmail;
  const e = s.staff[role];
  if (!e) throw new Error(`no ${role} in the e2e clinic`);
  return e;
}

/** Sign in through the real login form and land past the sign-in pop-up. */
export async function login(page: Page, role: string) {
  const s = stack();
  // The clinic's own sign-in link chooses the clinic (step one is skipped).
  await page.goto(`/login/${s.slug}`);
  await page.locator("#email").fill(emailFor(role));
  await page.locator("#password").fill(s.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await dismissSignInDialog(page);
}

/** The sign-in notifications dialog may or may not appear; Escape closes it. */
export async function dismissSignInDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  try {
    await dialog.first().waitFor({ state: "visible", timeout: 2_500 });
    await page.keyboard.press("Escape");
    await dialog.first().waitFor({ state: "hidden", timeout: 5_000 });
  } catch {
    /* no pop-up this time */
  }
}

/** A signed-in API call outside the browser, for arranging test data. */
export async function apiAs(role: string) {
  const s = stack();
  const r = await fetch(`${s.apiBase}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: s.slug, email: emailFor(role), password: s.password }),
  });
  const j = (await r.json()) as { data?: { access_token?: string } };
  const token = j.data?.access_token;
  if (!r.ok || !token) throw new Error(`api login ${role}: ${r.status} ${JSON.stringify(j)}`);
  return async <T = unknown>(method: string, p: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${s.apiBase}${p}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as { data?: T };
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(out)}`);
    return out.data as T;
  };
}

/** A signed-in vendor (super-admin) API call, for arranging what only the console can. */
export async function platformApi() {
  const s = stack();
  const r = await fetch(`${s.apiBase}/platform/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: s.platformEmail, password: s.password }),
  });
  const j = (await r.json()) as { data?: { access_token?: string } };
  const token = j.data?.access_token;
  if (!r.ok || !token) throw new Error(`platform login: ${r.status} ${JSON.stringify(j)}`);
  return async <T = unknown>(method: string, p: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${s.apiBase}${p}`, {
      method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const out = (await res.json().catch(() => ({}))) as { data?: T };
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(out)}`);
    return out.data as T;
  };
}

export const uniq = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`;
