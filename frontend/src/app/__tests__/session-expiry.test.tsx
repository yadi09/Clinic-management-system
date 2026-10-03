// What happens when a session dies while someone is using it — the real api client,
// the real AuthProvider and ProtectedRoute, with only the network faked.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 60_000 });

import { AuthProvider } from "@/app/auth-context";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { apiFetch } from "@/lib/api-client";
import { tokenStore } from "@/lib/token";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = {
  user: { id: "u1", tenant_id: "t", email: "a@b.c", full_name: "Hanna", roles: [] },
  permissions: [], flags: {}, branches: [], all_branches: false,
};

function Patients() {
  const q = useQuery({ queryKey: ["p"], queryFn: () => apiFetch<string[]>("/patients"), retry: false });
  return <p>{q.isError ? "Could not load patients" : q.data ? "Patients list" : "…"}</p>;
}

let qc: QueryClient;
function App() {
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/patients"]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<h1>Sign in</h1>} />
            <Route element={<ProtectedRoute />}>
              <Route path="/patients" element={<Patients />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

let refreshOk: boolean;
let patientsStatus: number;
beforeEach(() => {
  qc = new QueryClient();
  tokenStore.clear();
  sessionStorage.clear();
  refreshOk = true;
  patientsStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/auth/refresh")) return refreshOk ? json(200, { data: { access_token: "t1" } }) : json(401, {});
    if (url.endsWith("/auth/me")) return json(200, { data: ME });
    if (url.endsWith("/patients")) return patientsStatus === 200 ? json(200, { data: ["a"] }) : json(patientsStatus, { error: { code: "UNAUTHENTICATED", message: "expired" } });
    return json(404, {});
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("REG-FE-SESSION session expiry", () => {
  test("REG-FE-SESSION-001 a live session reaches the page; no cookie goes to sign-in", async () => {
    const r = render(<App />);
    expect(await screen.findByText("Patients list", undefined, { timeout: 4000 })).toBeInTheDocument();
    r.unmount();
    qc = new QueryClient();
    refreshOk = false;
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" }, { timeout: 4000 })).toBeInTheDocument();
  });

  // FE-1 (the "nobody tells the session" half, fixed with SEC-2/SEC-10 on
  // 2026-10-03). Once the refresh cookie is gone (revoked by a racing refresh in
  // another tab, by a lock-out, or lost), every request 401s and the refresh fails.
  // The app now signs out and goes to sign-in instead of a screen of errors.
  test("REG-FE-SESSION-002 a refresh that fails mid-session sends the user to sign in, saying why", async () => {
    render(<App />);
    await screen.findByText("Patients list", undefined, { timeout: 4000 });
    refreshOk = false;
    patientsStatus = 401;
    await qc.refetchQueries({ queryKey: ["p"] }).catch(() => {});
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument(), { timeout: 4000 });
    expect(sessionStorage.getItem("clinicos.session_end")).toBe("expired");
    expect(tokenStore.get()).toBeFalsy();
  });

  test("REG-FE-SESSION-005 the session still ends when the browser blocks storage (the reason is just not kept)", async () => {
    render(<App />);
    await screen.findByText("Patients list");
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "QuotaExceededError");
    });
    refreshOk = false;
    patientsStatus = 401;
    await qc.refetchQueries({ queryKey: ["p"] }).catch(() => {});
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument());
    expect(tokenStore.get()).toBeFalsy();
    set.mockRestore();
  });

  // SEC-10: a clinic suspended while its staff are working.
  test("REG-FE-SESSION-003 a clinic suspended mid-session signs out and says the workspace is suspended", async () => {
    render(<App />);
    await screen.findByText("Patients list", undefined, { timeout: 4000 });
    patientsStatus = 403;
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/patients")) return json(403, { error: { code: "TENANT_INACTIVE", message: "this workspace is not active" } });
      return json(404, {});
    });
    await qc.refetchQueries({ queryKey: ["p"] }).catch(() => {});
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument(), { timeout: 4000 });
    expect(sessionStorage.getItem("clinicos.session_end")).toBe("clinic-suspended");
  });

  test("REG-FE-SESSION-004 a refusal that is not about the session (403 for a permission) does not sign anyone out", async () => {
    render(<App />);
    await screen.findByText("Patients list", undefined, { timeout: 4000 });
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/patients")) return json(403, { error: { code: "FORBIDDEN", message: "no permission" } });
      return json(404, {});
    });
    await qc.refetchQueries({ queryKey: ["p"] }).catch(() => {});
    await screen.findByText("Could not load patients", undefined, { timeout: 4000 });
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(sessionStorage.getItem("clinicos.session_end")).toBeNull();
  });
});
