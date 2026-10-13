// When the server cannot be reached the app must say so, and a save that got no
// answer must never look like a save that worked (FE-3). Every request has a time
// limit; a refusal from the server is still an answer; and the shared "can we reach
// the server" signal follows what requests and the browser report.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type Api = typeof import("@/lib/api-client");
type Conn = typeof import("@/lib/connection");
type Err = InstanceType<Api["AppError"]>;

let api: Api;
let conn: Conn;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
/** A server that never answers, but lets go when the caller gives up. */
const silent = () => (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
const offline = () => new TypeError("Failed to fetch");
/** The error a request ends with. Attached at once, so a request left waiting on a fake clock is not "unhandled". */
const failure = async (p: Promise<unknown>): Promise<Err> => {
  try { await p; } catch (e) { return e as Err; }
  throw new Error("expected the request to fail");
};

async function load() {
  vi.resetModules();
  api = await import("@/lib/api-client");
  conn = await import("@/lib/connection");
  (await import("@/lib/token")).tokenStore.set("t");
}

beforeEach(async () => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await load();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("REG-FE-API request time limits (FE-3)", () => {
  test("REG-FE-API-018 a read nobody answers gives up after 30 seconds and says to try again", async () => {
    fetchMock.mockImplementation(silent());
    const got = failure(api.apiFetch("/patients"));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(conn.link.get()).toBe("ok"); // still waiting, not yet a verdict
    await vi.advanceTimersByTimeAsync(2);
    const e = await got;
    expect(e).toMatchObject({ name: "AppError", status: 0, code: "TIMEOUT" });
    expect(e.message).toBe("The server took too long to answer. Please try again.");
    expect(conn.link.get()).toBe("slow");
  });

  test("REG-FE-API-019 a save nobody answers says it may not have been saved, so it is checked before it is repeated", async () => {
    fetchMock.mockImplementation(silent());
    const got = failure(api.apiFetch("/payments", { method: "POST", body: { x: 1 } }));
    await vi.advanceTimersByTimeAsync(30_001);
    const e = await got;
    expect(e.code).toBe("TIMEOUT");
    expect(e.message).toContain("may not have been saved");
    expect(e.message).toContain("check before doing it again");
  });

  test("REG-FE-API-020 work that is slow by nature (the Ministry's server, a whole register) is given two minutes", async () => {
    fetchMock.mockImplementation(silent());
    for (const path of ["/reporting/dhis2/push", "/patients/import", "/lab/catalog/import", "/history-import", "/encounters/enc_1/assist"]) {
      expect(api.waitFor(path), path).toBe(120_000);
    }
    expect(api.waitFor("/patients")).toBe(30_000);
    expect(api.waitFor("/patients/pat_1")).toBe(30_000);
    const got = failure(api.apiFetch("/reporting/dhis2/push", { method: "POST" }));
    await vi.advanceTimersByTimeAsync(31_000);
    expect(conn.link.get()).toBe("ok"); // a 30-second wait would already have given up
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await got).code).toBe("TIMEOUT");
  });

  test("REG-FE-API-021 a caller can set its own limit", async () => {
    fetchMock.mockImplementation(silent());
    const got = failure(api.apiFetch("/x", { timeoutMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await got).code).toBe("TIMEOUT");
  });

  test("REG-FE-API-022 a request the browser cannot send is 'could not reach the server', never a raw 'Failed to fetch'", async () => {
    fetchMock.mockRejectedValue(offline());
    const read = await failure(api.apiFetch("/patients"));
    expect(read).toMatchObject({ name: "AppError", status: 0, code: "NETWORK" });
    expect(read.message).toBe("Could not reach the server. Check your connection and try again.");
    expect(conn.link.get()).toBe("down");

    const write = await failure(api.apiFetch("/patients", { method: "POST", body: {} }));
    expect(write.code).toBe("NETWORK");
    expect(write.message).toContain("not confirmed as saved");
    expect(write.message).toContain("check whether it saved before doing it again");
  });

  test("REG-FE-API-023 any answer from the server, even a refusal, means it is reachable again", async () => {
    fetchMock.mockRejectedValueOnce(offline());
    await api.apiFetch("/a").catch(() => {});
    expect(conn.link.get()).toBe("down");
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: "FORBIDDEN", message: "no" } }));
    await expect(api.apiFetch("/a")).rejects.toMatchObject({ status: 403 });
    expect(conn.link.get()).toBe("ok");
  });

  test("REG-FE-API-030 an answer whose body is cut off halfway is a connection failure, not a half-read answer", async () => {
    const cut = new Response(new ReadableStream({ start(c) { c.error(new TypeError("network error")); } }), { status: 200 });
    fetchMock.mockResolvedValueOnce(cut);
    const e = await failure(api.apiFetch("/a"));
    expect(e.code).toBe("NETWORK");
    expect(conn.link.get()).toBe("down");
  });

  test("REG-FE-API-024 the server's own errors are still the server's words, not a connection message", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: "CONFLICT", message: "already done" } }));
    await expect(api.apiFetch("/a", { method: "POST" })).rejects.toMatchObject({ status: 409, code: "CONFLICT", message: "already done" });
    expect(conn.link.get()).toBe("ok");
  });

  test("REG-FE-API-025 a sign-in renewal that cannot reach the server reports false and marks the link down", async () => {
    fetchMock.mockRejectedValue(offline());
    await expect(api.trySilentRefresh()).resolves.toBe(false);
    expect(conn.link.get()).toBe("down");
  });

  test("REG-FE-API-031 a sign-in renewal answered with nothing at all is a failed renewal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.trySilentRefresh()).resolves.toBe(false);
    expect(conn.link.get()).toBe("ok"); // the server did answer
  });

  test("REG-FE-API-026 an expired session is still renewed and the request retried, with the limit in place", async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(json(200, { data: { access_token: "n" } }))
      .mockResolvedValueOnce(json(200, { data: { ok: 1 } }));
    await expect(api.apiFetch("/a")).resolves.toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });
});

describe("REG-FE-API files sent straight to storage (FE-3)", () => {
  const file = new Blob(["x"], { type: "image/png" });

  test("REG-FE-API-027 an upload nobody answers gives up after two minutes, in its own words, without blaming our server", async () => {
    fetchMock.mockImplementation(silent());
    const got = failure(api.sendFile("https://storage.example/put", { method: "PUT", body: file }));
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    const e = await got;
    expect(e).toMatchObject({ name: "AppError", status: 0, code: "TIMEOUT" });
    expect(e.message).toBe("The upload took too long. Check your connection and try again.");
    expect(conn.link.get()).toBe("ok"); // the storage provider being slow says nothing about our server
  });

  test("REG-FE-API-028 an upload that cannot be sent says so plainly", async () => {
    fetchMock.mockRejectedValue(offline());
    const e = await failure(api.sendFile("https://storage.example/put", { method: "PUT", body: file }));
    expect(e).toMatchObject({ code: "NETWORK", status: 0 });
    expect(e.message).toBe("Could not upload the file. Check your connection and try again.");
    expect(conn.link.get()).toBe("ok");
  });

  test("REG-FE-API-029 a refusal from the storage provider is handed back for the caller to read, as before", async () => {
    fetchMock.mockResolvedValue(new Response("denied", { status: 403 }));
    const res = await api.sendFile("https://storage.example/put", { method: "PUT", body: file, headers: { "Content-Type": "image/png" } });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://storage.example/put");
    expect(init).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/png" } });
  });
});

describe("REG-FE-CONN the connection signal", () => {
  test("REG-FE-CONN-001 the browser going offline marks it down; coming back asks the server before trusting it", async () => {
    fetchMock.mockResolvedValue(json(200, { status: "ok" }));
    window.dispatchEvent(new Event("offline"));
    expect(conn.link.get()).toBe("down");
    window.dispatchEvent(new Event("online"));
    // "online" is only a hint: still down until the server itself answers.
    expect(conn.link.get()).toBe("down");
    await vi.advanceTimersByTimeAsync(0);
    expect(conn.link.get()).toBe("ok");
    expect(String(fetchMock.mock.calls.at(-1)![0])).toMatch(/\/healthz$/);
  });

  test("REG-FE-CONN-002 while it is not ok the server is asked every 8 seconds, and the asking stops once it answers", async () => {
    fetchMock.mockRejectedValue(offline());
    await api.apiFetch("/a").catch(() => {});
    expect(conn.link.get()).toBe("down");
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(conn.link.get()).toBe("down");

    fetchMock.mockResolvedValue(json(200, { status: "ok" }));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(conn.link.get()).toBe("ok");
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("REG-FE-CONN-003 the check goes to the server's own address, not through the API", async () => {
    fetchMock.mockRejectedValue(offline());
    await api.apiFetch("/a").catch(() => {});
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(8_000);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toMatch(/^https?:\/\/[^/]+\/healthz$/);
    expect(url).not.toContain("/api/");
    expect((fetchMock.mock.calls[0][1] as RequestInit).cache).toBe("no-store");
  });

  test("REG-FE-CONN-011 when the app is built against another address, the check goes to that server's own address", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/api/v1");
    await load();
    fetchMock.mockRejectedValue(offline());
    await api.apiFetch("/a").catch(() => {});
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.example.com/healthz");
    vi.unstubAllEnvs();
  });

  test("REG-FE-CONN-004 a check that itself gets no answer is given up on, and the next one tries again", async () => {
    fetchMock.mockRejectedValue(offline());
    await api.apiFetch("/a").catch(() => {});
    fetchMock.mockImplementation(silent());
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(8_000 + 5_001);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(conn.link.get()).toBe("down");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-CONN-005 a page opened with no network starts as down", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.resetModules();
    const fresh: Conn = await import("@/lib/connection");
    expect(fresh.link.get()).toBe("down");
  });

  test("REG-FE-CONN-006 subscribers hear every change once, and not a repeat of the same state", async () => {
    const seen: string[] = [];
    const off = conn.link.subscribe(() => seen.push(conn.link.get()));
    conn.setLink("down");
    conn.setLink("down");
    conn.setLink("slow");
    conn.setLink("ok");
    off();
    conn.setLink("down");
    expect(seen).toEqual(["down", "slow", "ok"]);
  });
});
