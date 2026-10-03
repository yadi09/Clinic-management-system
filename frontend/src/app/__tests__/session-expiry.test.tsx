// What happens when a session dies while someone is using it — the real api client,
// the real AuthProvider and ProtectedRoute, with only the network faked.
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 20_000 });

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

  // FE-1. Once the refresh cookie is gone (revoked by a racing refresh in another
  // tab, or by a lost refresh response), every request 401s, the refresh fails,
  // and the error is handed to the page — but nobody tells the session. The user
  // sits on a screen of "Could not load" errors with no route back to sign-in.
  test.fails("REG-FE-SESSION-002 KNOWN BUG FE-1 a refresh that fails mid-session sends the user to sign in", async () => {
    render(<App />);
    await screen.findByText("Patients list", undefined, { timeout: 4000 });
    // The session dies: the next call 401s and the cookie no longer refreshes.
    refreshOk = false;
    patientsStatus = 401;
    await qc.refetchQueries({ queryKey: ["p"] });
    // Today the page just says it could not load, and stays.
    await screen.findByText("Could not load patients", undefined, { timeout: 4000 });
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "Sign in" }).length).toBeGreaterThan(0), { timeout: 1500 });
  });
});
