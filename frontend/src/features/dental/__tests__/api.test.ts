// The dental API client's wire contract: for every call, the path, the method and
// the body the server expects. The screens' tests mock these functions; this file is
// what makes sure the functions themselves still say the right thing to the server.
// Also: the chart diff a save sends, the three-step image upload, and the one list
// of caches a dental change refreshes.
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const http = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), apiFetch: http.apiFetch }));

import * as d from "@/features/dental/api";
import { invalidateDental } from "@/features/dental/invalidate";

const P = "pat_1";
const last = () => http.apiFetch.mock.calls.at(-1) as [string, { method?: string; body?: unknown; keepalive?: boolean }?];

describe("REG-FE-MONEY dental API contract", () => {
  beforeEach(() => { http.apiFetch.mockReset(); http.apiFetch.mockResolvedValue({}); });
  afterEach(() => vi.unstubAllGlobals());

  test("REG-FE-MONEY-012 reads go to the patient-scoped GET paths", () => {
    const reads: [() => unknown, string][] = [
      [() => d.dentalSummary(P), `/dental/patients/${P}/summary`],
      [() => d.listPlans(P), `/dental/patients/${P}/plans`],
      [() => d.dentalOutstanding(), "/dental/outstanding"],
      [() => d.listDentalSessions("2026-10-01", "2026-10-31"), "/dental/sessions?from=2026-10-01&to=2026-10-31"],
      [() => d.listDentalImages(P), `/dental/patients/${P}/images`],
      [() => d.listDentalImages(P, "ses 1"), `/dental/patients/${P}/images?session=ses%201`],
      [() => d.listExams(P), `/dental/patients/${P}/exams`],
      [() => d.listProcedures(), "/dental/procedures"],
      [() => d.listProcedures(true), "/dental/procedures?all=1"],
      [() => d.listToothStatuses(), "/dental/tooth-statuses"],
      [() => d.listToothStatuses(true), "/dental/tooth-statuses?all=1"],
      [() => d.unbilledTreatment(), "/dental/unbilled"],
      [() => d.unbilledTreatment({ from: "2026-09-01", to: "2026-09-30", limit: 50, offset: 100 }),
        "/dental/unbilled?from=2026-09-01&to=2026-09-30&limit=50&offset=100"],
      [() => d.chairside(), "/dental/chairside?"],
      [() => d.chairside("usr_1", "2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"),
        "/dental/chairside?provider=usr_1&from=2026-10-02T00%3A00%3A00Z&to=2026-10-03T00%3A00%3A00Z"],
    ];
    for (const [call, path] of reads) {
      call();
      expect(last()[0]).toBe(path);
      expect(last()[1]?.method).toBeUndefined();
    }
  });

  test("REG-FE-MONEY-013 writes send the method and body the server expects", () => {
    const S = "ses_1", PL = "pln_1";
    const writes: [() => unknown, string, string, unknown?][] = [
      [() => d.saveChart(P, { "11": "decayed" }), `/dental/patients/${P}/chart`, "PUT", { changes: { "11": "decayed" } }],
      [() => d.addExtra(P, S, { service_id: "svc_1", amount: "300" }), `/dental/patients/${P}/sessions/${S}/extras`, "POST", { service_id: "svc_1", amount: "300" }],
      [() => d.removeExtra(P, "ext_1"), `/dental/patients/${P}/extras/ext_1`, "DELETE"],
      [() => d.createPlan(P, { title: "RCT" } as d.CreatePlanBody), `/dental/patients/${P}/plans`, "POST", { title: "RCT" }],
      [() => d.updatePlan(P, PL, { note: "n" }), `/dental/patients/${P}/plans/${PL}`, "PUT", { note: "n" }],
      [() => d.deletePlan(P, PL), `/dental/patients/${P}/plans/${PL}`, "DELETE"],
      [() => d.repriceSession(P, S, { amount: "900", mode: "total", reason: "r" }), `/dental/patients/${P}/sessions/${S}/reprice`, "POST", { amount: "900", mode: "total", reason: "r" }],
      [() => d.updateSession(P, S, { notes: "x" }), `/dental/patients/${P}/sessions/${S}`, "PUT", { notes: "x" }],
      [() => d.rescheduleSession(P, S, "2026-10-09"), `/dental/patients/${P}/sessions/${S}/reschedule`, "POST", { scheduled_date: "2026-10-09" }],
      [() => d.collectSession(P, S), `/dental/patients/${P}/sessions/${S}/collect`, "POST"],
      [() => d.uncollectSession(P, S, "wrong"), `/dental/patients/${P}/sessions/${S}/uncollect`, "POST", { reason: "wrong" }],
      [() => d.collectSessions(P), `/dental/patients/${P}/collect-sessions`, "POST", { session_ids: [] }],
      [() => d.collectSessions(P, ["a", "b"]), `/dental/patients/${P}/collect-sessions`, "POST", { session_ids: ["a", "b"] }],
      [() => d.setPayLater(P, S, { on: true, note: "Friday" }), `/dental/patients/${P}/sessions/${S}/pay-later`, "POST", { on: true, note: "Friday" }],
      [() => d.addPrescription(P, S, { items: [] }), `/dental/patients/${P}/sessions/${S}/prescriptions`, "POST", { items: [] }],
      [() => d.deletePrescription(P, "rx_1", "typo"), `/dental/patients/${P}/prescriptions/rx_1`, "DELETE", { reason: "typo" }],
      [() => d.deleteDentalImage(P, "img_1"), `/dental/patients/${P}/images/img_1`, "DELETE"],
      [() => d.createExam(P, { chief_complaint: "pain" } as unknown as d.ExamBody), `/dental/patients/${P}/exams`, "POST", { chief_complaint: "pain" }],
      [() => d.updateExam(P, "exm_1", { chief_complaint: "pain" } as unknown as d.ExamBody), `/dental/patients/${P}/exams/exm_1`, "PUT", { chief_complaint: "pain" }],
      [() => d.deleteExam(P, "exm_1"), `/dental/patients/${P}/exams/exm_1`, "DELETE"],
      [() => d.addSession(P, PL, { scheduled_date: "2026-11-01", amount_due: "2000" }), `/dental/patients/${P}/plans/${PL}/sessions`, "POST", { scheduled_date: "2026-11-01", amount_due: "2000" }],
      [() => d.cancelCourse(P, PL, "moved away"), `/dental/patients/${P}/plans/${PL}/cancel`, "POST", { reason: "moved away" }],
      [() => d.finishCourse(P, PL), `/dental/patients/${P}/plans/${PL}/finish`, "POST"],
      [() => d.writeOffSession(P, S, "goodwill"), `/dental/patients/${P}/sessions/${S}/write-off`, "POST", { reason: "goodwill" }],
      [() => d.undoWriteOff(P, S), `/dental/patients/${P}/sessions/${S}/undo-write-off`, "POST"],
      [() => d.createProcedure("Scaling"), "/dental/procedures", "POST", { name: "Scaling" }],
      [() => d.updateProcedure("prc_1", { name: "Scaling", is_active: false }), "/dental/procedures/prc_1", "PUT", { name: "Scaling", is_active: false }],
      [() => d.deleteProcedure("prc_1"), "/dental/procedures/prc_1", "DELETE"],
      [() => d.reorderProcedures(["b", "a"]), "/dental/procedures/reorder", "POST", { ids: ["b", "a"] }],
      [() => d.createToothStatus("Bridge", "#123456"), "/dental/tooth-statuses", "POST", { label: "Bridge", color: "#123456" }],
      [() => d.updateToothStatus("tst_1", { label: "Bridge", color: "#000" }), "/dental/tooth-statuses/tst_1", "PUT", { label: "Bridge", color: "#000" }],
      [() => d.deleteToothStatus("tst_1"), "/dental/tooth-statuses/tst_1", "DELETE"],
      [() => d.reorderToothStatuses(["x"]), "/dental/tooth-statuses/reorder", "POST", { ids: ["x"] }],
    ];
    for (const [call, path, method, body] of writes) {
      call();
      const [p, init] = last();
      expect(p, path).toBe(path);
      expect(init?.method, path).toBe(method);
      expect(init?.body, path).toEqual(body);
    }
  });

  test("REG-FE-MONEY-014 a chart save leaving the page asks the browser to keep it alive", () => {
    d.saveChart(P, { "11": "" }, { keepalive: true });
    expect(last()[1]).toMatchObject({ method: "PUT", keepalive: true, body: { changes: { "11": "" } } });
  });

  test("REG-FE-MONEY-015 chartChanges sends only the teeth that differ, and a cleared tooth as empty", () => {
    expect(d.chartChanges({ "11": "decayed", "12": "filled" }, { "11": "decayed", "12": "crown", "13": "filled" }))
      .toEqual({ "12": "crown", "13": "filled" });
    expect(d.chartChanges({ "11": "decayed" }, {})).toEqual({ "11": "" });
    expect(d.chartChanges({}, {})).toEqual({});
  });

  test("REG-FE-MONEY-016 image upload: sign, PUT the file to storage, then record it under the visit", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    http.apiFetch
      .mockResolvedValueOnce({ url: "https://r2.example/put", method: "put", key: "k/1.jpg" })
      .mockResolvedValueOnce({ id: "img_1" });
    const file = new File(["abc"], "x.jpg", { type: "image/jpeg" });
    await expect(d.uploadDentalImage(P, file, "ses_1", "xray")).resolves.toEqual({ id: "img_1" });
    expect(http.apiFetch.mock.calls[0]).toEqual([`/dental/patients/${P}/images/sign`, { method: "POST", body: { filename: "x.jpg", mime_type: "image/jpeg" } }]);
    expect(fetchMock).toHaveBeenCalledWith("https://r2.example/put", { method: "PUT", body: file, headers: { "Content-Type": "image/jpeg" }, signal: expect.any(AbortSignal) });
    expect(http.apiFetch.mock.calls[1]).toEqual([`/dental/patients/${P}/images`, {
      method: "POST",
      body: { storage_key: "k/1.jpg", filename: "x.jpg", mime_type: "image/jpeg", size_bytes: 3, session_id: "ses_1", category: "xray" },
    }]);
  });

  test("REG-FE-MONEY-017 image upload by form POST carries the signed fields, and a failed upload records nothing", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: { body: FormData }) => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    http.apiFetch
      .mockResolvedValueOnce({ url: "https://cloud.example/up", key: "k2", fields: { signature: "sig", api_key: "ak" } })
      .mockResolvedValueOnce({ id: "img_2" });
    const file = new File(["abcd"], "y.png", { type: "image/png" });
    await d.uploadDentalImage(P, file);
    const fd = fetchMock.mock.calls[0][1].body;
    expect(fetchMock.mock.calls[0][0]).toBe("https://cloud.example/up");
    expect(fd.get("signature")).toBe("sig");
    expect(fd.get("api_key")).toBe("ak");
    expect((fd.get("file") as File).name).toBe("y.png");

    // Storage refuses: the error surfaces and no metadata row is created.
    for (const method of ["PUT", undefined]) {
      http.apiFetch.mockReset();
      http.apiFetch.mockResolvedValueOnce({ url: "https://s/", method, key: "k3" });
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
      await expect(d.uploadDentalImage(P, file)).rejects.toThrow("Upload failed");
      expect(http.apiFetch).toHaveBeenCalledTimes(1);
    }
  });

  test("REG-FE-MONEY-018 a dental change refreshes the summary, the ledger, the calendar and the cashier lists", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateDental(qc, P);
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    for (const k of [["dental-summary", P], ["patient-charges", P], ["patient-appointments", P], ["dental-images", P],
      ["dental-exams", P], ["patient", P], ["dental-cal"], ["dental-outstanding"], ["dental-unbilled"], ["chairside"], ["pending-charges"]]) {
      expect(keys).toContain(JSON.stringify(k));
    }
  });
});
