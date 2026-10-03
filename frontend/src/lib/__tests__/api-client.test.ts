// The one door every request goes through. What it must get right: the access
// token rides along, a 401 is answered by ONE refresh no matter how many requests
// hit it at once, the request is retried once with the new token, and an error is
// always an AppError with the server's own words — never "Unexpected token '<'".
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Api = typeof import("@/lib/api-client");
type Tok = typeof import("@/lib/token");

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const text = (status: number, body: string) => new Response(body, { status });

let fetchMock: ReturnType<typeof vi.fn>;
let api: Api;
let tok: Tok;

/** A fresh module per test: the coalescing promise is module state. */
async function load() {
  vi.resetModules();
  api = await import("@/lib/api-client");
  tok = await import("@/lib/token");
  tok.tokenStore.clear();
}

const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }));
const authHeader = (i: number) => (calls()[i].init.headers as Record<string, string>).Authorization;

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await load();
});
afterEach(() => vi.unstubAllGlobals());

describe("REG-FE-API api client", () => {
  test("REG-FE-API-001 the access token is attached, the body is JSON, cookies are sent", async () => {
    tok.tokenStore.set("tok-A");
    fetchMock.mockResolvedValueOnce(json(200, { data: { ok: 1 } }));
    const out = await api.apiFetch("/patients", { method: "POST", body: { name: "Abebe" } });
    expect(out).toEqual({ ok: 1 });
    const [c] = calls();
    expect(c.url).toBe("/api/v1/patients");
    expect(c.init.method).toBe("POST");
    expect(c.init.credentials).toBe("include");
    expect(c.init.body).toBe(JSON.stringify({ name: "Abebe" }));
    expect(authHeader(0)).toBe("Bearer tok-A");
    expect((c.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  test("REG-FE-API-002 no token: no Authorization header; auth:false never sends one", async () => {
    fetchMock.mockImplementation(async () => json(200, { data: 1 }));
    await api.apiFetch("/a");
    expect(authHeader(0)).toBeUndefined();
    tok.tokenStore.set("tok-A");
    await api.apiFetch("/b", { auth: false });
    expect(authHeader(1)).toBeUndefined();
  });

  test("REG-FE-API-003 extra headers are passed and keepalive lets a save outlive the tab", async () => {
    fetchMock.mockImplementation(async () => json(200, { data: 1 }));
    await api.apiFetch("/c", { headers: { "X-Campaign": "k1" }, keepalive: true });
    expect((calls()[0].init.headers as Record<string, string>)["X-Campaign"]).toBe("k1");
    expect(calls()[0].init.keepalive).toBe(true);
    expect(calls()[0].init.body).toBeUndefined();
  });

  test("REG-FE-API-004 a 401 refreshes once and retries the request with the new token", async () => {
    tok.tokenStore.set("old");
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: "UNAUTHENTICATED", message: "expired" } }))
      .mockResolvedValueOnce(json(200, { data: { access_token: "new" } }))
      .mockResolvedValueOnce(json(200, { data: ["row"] }));
    await expect(api.apiFetch("/rows")).resolves.toEqual(["row"]);
    expect(calls().map((c) => c.url)).toEqual(["/api/v1/rows", "/api/v1/auth/refresh", "/api/v1/rows"]);
    expect(calls()[1].init.method).toBe("POST");
    expect(authHeader(2)).toBe("Bearer new");
    expect(tok.tokenStore.get()).toBe("new");
  });

  test("REG-FE-API-005 a burst of 401s shares ONE refresh", async () => {
    tok.tokenStore.set("old");
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/auth/refresh")) { refreshes++; await new Promise((r) => setTimeout(r, 5)); return json(200, { data: { access_token: "new" } }); }
      const h = init.headers as Record<string, string>;
      return h.Authorization === "Bearer new" ? json(200, { data: url }) : json(401, {});
    });
    const out = await Promise.all([api.apiFetch("/a"), api.apiFetch("/b"), api.apiFetch("/c")]);
    expect(out).toEqual(["/api/v1/a", "/api/v1/b", "/api/v1/c"]);
    expect(refreshes).toBe(1);
  });

  test("REG-FE-API-006 the retried request is not refreshed again: a second 401 is the caller's error", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { data: { access_token: "new" } }))
      .mockResolvedValueOnce(json(401, { error: { code: "UNAUTHENTICATED", message: "still no" } }));
    const err = (await api.apiFetch("/x").catch((e: unknown) => e)) as InstanceType<Api["AppError"]>;
    expect(err).toBeInstanceOf(api.AppError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("still no");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("REG-FE-API-007 a failed refresh (refused, no token, or network) surfaces the original 401", async () => {
    for (const refresh of [
      () => json(401, {}),
      () => json(200, { data: {} }),
      () => { throw new TypeError("Failed to fetch"); },
    ]) {
      await load();
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(json(401, { error: { code: "UNAUTHENTICATED", message: "expired" } }))
        .mockImplementationOnce(async () => refresh());
      const err = (await api.apiFetch("/x").catch((e: unknown) => e)) as InstanceType<Api["AppError"]>;
      expect(err).toMatchObject({ name: "AppError", status: 401, code: "UNAUTHENTICATED" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  });

  test("REG-FE-API-008 retry:false and auth:false skip the refresh (sign-in, MFA, logout)", async () => {
    fetchMock.mockImplementation(async () => json(401, { error: { code: "BAD_CREDENTIALS", message: "Wrong email or password" } }));
    await expect(api.apiFetch("/auth/login", { auth: false, retry: false })).rejects.toThrow("Wrong email or password");
    await expect(api.apiFetch("/y", { retry: false })).rejects.toThrow();
    expect(calls().some((c) => c.url.endsWith("/auth/refresh"))).toBe(false);
  });

  test("REG-FE-API-009 the server's error envelope becomes an AppError with code, request id and details", async () => {
    const body = { error: { code: "VALIDATION", message: "Phone is invalid", request_id: "req_9", details: { phone: "bad" } } };
    fetchMock.mockResolvedValueOnce(json(422, body));
    const err = (await api.apiFetch("/z").catch((e: unknown) => e)) as InstanceType<Api["AppError"]>;
    expect(err).toBeInstanceOf(api.AppError);
    expect(err).toMatchObject({ status: 422, code: "VALIDATION", message: "Phone is invalid", requestId: "req_9", details: { phone: "bad" } });
    expect(err.body).toEqual(body);
  });

  test("REG-FE-API-010 an error without an envelope still has a code and a message", async () => {
    fetchMock.mockResolvedValueOnce(json(500, {})).mockResolvedValueOnce(text(404, ""));
    await expect(api.apiFetch("/a")).rejects.toMatchObject({ status: 500, code: "ERROR", message: "Request failed" });
    await expect(api.apiFetch("/b")).rejects.toMatchObject({ status: 404, code: "ERROR" });
  });

  test("REG-FE-API-011 an HTML gateway page is a clean message, not a JSON parse error", async () => {
    fetchMock.mockResolvedValueOnce(text(502, "<html>Bad gateway</html>")).mockResolvedValueOnce(text(200, "<html>oops</html>"));
    await expect(api.apiFetch("/a")).rejects.toMatchObject({
      status: 502, code: "UPSTREAM_ERROR", message: "The server had trouble with that request. Please try again in a moment.",
    });
    await expect(api.apiFetch("/b")).rejects.toMatchObject({ code: "UPSTREAM_ERROR", message: "The server returned an unexpected response." });
  });

  test("REG-FE-API-012 204 and empty bodies resolve; a body without a data envelope is returned whole", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(text(200, ""))
      .mockResolvedValueOnce(json(200, { plain: true }));
    await expect(api.apiFetch("/a")).resolves.toBeUndefined();
    await expect(api.apiFetch("/b")).resolves.toEqual({});
    await expect(api.apiFetch("/c")).resolves.toEqual({ plain: true });
  });

  test("REG-FE-API-013 apiList returns items and paging", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: [1, 2], meta: { page: 1, total: 2 } }));
    await expect(api.apiList("/l")).resolves.toEqual({ items: [1, 2], meta: { page: 1, total: 2 } });
  });

  // NEW-API-1. The Go envelope writes a nil slice as {"data":null} (httpx test
  // REG_KERNEL_HTTPX_013 pins exactly that body). `json.data ?? json` then hands the
  // caller the whole ENVELOPE as if it were the list, so every page that does
  // `(q.data ?? []).map(...)` gets an object and throws "map is not a function" —
  // a white screen for an empty list instead of "No staff yet".
  test.fails("REG-FE-API-016 KNOWN BUG NEW-API-1 {\"data\":null} is an empty answer, not the envelope", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { data: null }))
      .mockResolvedValueOnce(json(200, { data: null }));
    await expect(api.apiFetch("/users")).resolves.toBeNull();
    await expect(api.apiList("/l")).resolves.toEqual({ items: [], meta: {} });
  });

  test("REG-FE-API-014 trySilentRefresh restores the session from the cookie", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: { access_token: "boot" } }));
    await expect(api.trySilentRefresh()).resolves.toBe(true);
    expect(tok.tokenStore.get()).toBe("boot");
    // The coalescing slot frees itself, so a later refresh is a real request.
    await new Promise((r) => setTimeout(r, 1));
    fetchMock.mockResolvedValueOnce(json(401, {}));
    await expect(api.trySilentRefresh()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // FE-1. Refresh tokens rotate, so two refreshes racing with the same cookie means
  // the second presents a token that was just revoked — the server's reuse
  // detection then revokes every session. Inside one tab the refresh is shared;
  // across tabs nothing is (no BroadcastChannel, no Web Lock), so two open tabs
  // whose access tokens expire together still race.
  test.fails("REG-FE-API-015 KNOWN BUG FE-1 two tabs hitting a 401 together share one refresh", async () => {
    const tabA = api;
    vi.resetModules();
    const tabB: Api = await import("@/lib/api-client");
    let refreshes = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/refresh")) { refreshes++; return json(200, { data: { access_token: "n" } }); }
      return json(401, {});
    });
    await Promise.all([tabA.apiFetch("/a").catch(() => {}), tabB.apiFetch("/b").catch(() => {})]);
    expect(refreshes).toBe(1);
  });
});

describe("REG-FE-LIB small helpers", () => {
  test("REG-FE-LIB-001 token store set / get / clear", () => {
    tok.tokenStore.set("t");
    expect(tok.tokenStore.get()).toBe("t");
    tok.tokenStore.clear();
    expect(tok.tokenStore.get()).toBeNull();
  });

  test("REG-FE-LIB-002 rbac helpers answer false on missing lists", async () => {
    const r = await import("@/lib/rbac");
    expect(r.can(["a"], "a")).toBe(true);
    expect(r.can(undefined, "a")).toBe(false);
    expect(r.hasRole(["owner"], "owner")).toBe(true);
    expect(r.hasRole(undefined, "owner")).toBe(false);
    expect(r.hasAnyRole(["x", "doctor"], ["doctor", "nurse"])).toBe(true);
    expect(r.hasAnyRole(undefined, ["doctor"])).toBe(false);
    expect(r.isFlagOn({ dental: true }, "dental")).toBe(true);
    expect(r.isFlagOn(undefined, "dental")).toBe(false);
  });

  test("REG-FE-LIB-003 the shared query client retries once and does not refetch on focus", async () => {
    const q = await import("@/lib/query");
    const d = q.queryClient.getDefaultOptions().queries!;
    expect(d.retry).toBe(1);
    expect(d.refetchOnWindowFocus).toBe(false);
    expect(q.queryKeys.me).toEqual(["auth", "me"]);
  });
});
