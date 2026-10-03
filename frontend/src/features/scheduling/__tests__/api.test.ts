// The scheduling API wrappers: thin, but each one is the contract with the server.
// What they must get right: the path, the method, the query string (branch, window,
// provider — and nothing sent when a filter is not set) and the body, exactly as the
// Go handlers read them. apiFetch is mocked, so each test asserts what would have
// gone over the wire.
import { beforeEach, describe, expect, test, vi } from "vitest";

const http = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...http }));

const tok = vi.hoisted(() => ({ value: "tok en/1" as string | null }));
vi.mock("@/lib/token", async (orig) => {
  const real = await orig<{ tokenStore: object }>();
  return { ...real, tokenStore: { ...real.tokenStore, get: () => tok.value } };
});

import {
  assignProvider, bookAppointment, checkInAppointment, listAppointments, listFollowups, listPatientAppointments,
  listQueue, listUnassigned, listWorklist, markFollowup, queueStreamUrl, reassignProvider, receptionToday,
  rescheduleAppointment, setAppointmentStatus, transitionQueue, walkIn,
} from "@/features/scheduling/api";

const F = "2026-10-04T21:00:00.000Z";
const T = "2026-10-05T21:00:00.000Z";
const lastCall = () => http.apiFetch.mock.calls.at(-1)!;
/** The query string of the last call, as a plain object. */
const query = () => Object.fromEntries(new URL(`http://x${lastCall()[0] as string}`).searchParams);
const path = () => (lastCall()[0] as string).split("?")[0];

describe("REG-FE-SCHEDAPI scheduling api wrappers", () => {
  beforeEach(() => {
    http.apiFetch.mockReset();
    http.apiFetch.mockResolvedValue("ok");
    tok.value = "tok en/1";
  });

  test("REG-FE-SCHEDAPI-001 listAppointments: branch + window, provider only when given", async () => {
    await expect(listAppointments("br_1", F, T)).resolves.toBe("ok");
    expect(path()).toBe("/appointments");
    expect(query()).toEqual({ branch: "br_1", from: F, to: T });
    await listAppointments("br_1", F, T, "doc_2");
    expect(query()).toEqual({ branch: "br_1", from: F, to: T, provider: "doc_2" });
  });

  test("REG-FE-SCHEDAPI-002 listPatientAppointments sends the patient and no branch", async () => {
    await listPatientAppointments("pat_1", F, T);
    expect(path()).toBe("/appointments");
    expect(query()).toEqual({ patient: "pat_1", from: F, to: T });
  });

  test("REG-FE-SCHEDAPI-003 listFollowups: branch always, the window only when set", async () => {
    await listFollowups("br_1");
    expect(path()).toBe("/appointments/followups");
    expect(query()).toEqual({ branch: "br_1" });
    await listFollowups("br_1", F, T);
    expect(query()).toEqual({ branch: "br_1", from: F, to: T });
  });

  test("REG-FE-SCHEDAPI-004 reassign, book, reschedule, status, check-in and follow-up post the right bodies", async () => {
    await reassignProvider("ap_1", "doc_2", "on leave");
    expect(lastCall()).toEqual(["/appointments/ap_1/reassign", { method: "POST", body: { provider_id: "doc_2", note: "on leave" } }]);

    const body = { branch_id: "br_1", patient_id: "pat_1", provider_id: "doc_1", starts_at: F, duration_min: 30 };
    await bookAppointment(body);
    expect(lastCall()).toEqual(["/appointments", { method: "POST", body }]);

    await rescheduleAppointment("ap_1", { provider_id: "doc_1", starts_at: T, duration_min: 45 });
    expect(lastCall()).toEqual(["/appointments/ap_1", { method: "PUT", body: { provider_id: "doc_1", starts_at: T, duration_min: 45 } }]);

    await setAppointmentStatus("ap_1", "cancelled", "patient called");
    expect(lastCall()).toEqual(["/appointments/ap_1/status", { method: "POST", body: { status: "cancelled", cancel_reason: "patient called" } }]);

    await checkInAppointment("ap_1");
    expect(lastCall()).toEqual(["/appointments/ap_1/check-in", { method: "POST", body: { priority: 0 } }]);
    await checkInAppointment("ap_1", { priority: 2, to_triage: true, department_id: "dep_1" });
    expect(lastCall()[1]).toEqual({ method: "POST", body: { priority: 2, to_triage: true, department_id: "dep_1" } });

    await markFollowup("ap_1", T);
    expect(lastCall()).toEqual(["/appointments/ap_1/followup", { method: "POST", body: { free_until: T } }]);
  });

  test("REG-FE-SCHEDAPI-005 queue: department + optional stage and window; transitions and assignment", async () => {
    await listQueue("dep_1");
    expect(path()).toBe("/queue");
    expect(query()).toEqual({ department: "dep_1" });
    await listQueue("dep_1", "triage", { from: F, to: T });
    expect(query()).toEqual({ department: "dep_1", stage: "triage", from: F, to: T });
    await listQueue("dep_1", undefined, {});
    expect(query()).toEqual({ department: "dep_1" });

    await transitionQueue("q_1", "called");
    expect(lastCall()).toEqual(["/queue/q_1/transition", { method: "POST", body: { state: "called" } }]);
    await assignProvider("q_1", "doc_1");
    expect(lastCall()).toEqual(["/queue/q_1/assign", { method: "POST", body: { provider_id: "doc_1" } }]);
  });

  test("REG-FE-SCHEDAPI-006 worklist and unassigned: no '?' at all when nothing is filtered", async () => {
    await listWorklist();
    expect(lastCall()[0]).toBe("/worklist");
    await listWorklist("doc_1", F, T);
    expect(path()).toBe("/worklist");
    expect(query()).toEqual({ provider: "doc_1", from: F, to: T });

    await listUnassigned();
    expect(lastCall()[0]).toBe("/worklist/unassigned");
    await listUnassigned(F, T);
    expect(path()).toBe("/worklist/unassigned");
    expect(query()).toEqual({ from: F, to: T });
  });

  test("REG-FE-SCHEDAPI-007 walk-in and the reception list", async () => {
    const body = { department_id: "dep_1", patient_id: "pat_1", priority: 1 };
    await walkIn(body);
    expect(lastCall()).toEqual(["/queue/walk-in", { method: "POST", body }]);
    await receptionToday();
    expect(lastCall()).toEqual(["/reception/today"]);
  });

  test("REG-FE-SCHEDAPI-008 the queue stream URL carries the department and the token, URL-encoded", () => {
    const url = queueStreamUrl("dep 1&x");
    expect(url).toMatch(/\/queue\/stream\?/);
    const q = new URL(`http://x${url.replace(/^https?:\/\/[^/]+/, "")}`).searchParams;
    expect(q.get("department")).toBe("dep 1&x");
    expect(q.get("token")).toBe("tok en/1");
    tok.value = null;
    expect(queueStreamUrl("d")).toMatch(/token=$/);
  });
});
