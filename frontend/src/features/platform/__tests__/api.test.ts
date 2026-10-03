// The platform console's API client: its own token (never the clinic app's), the
// error contract, and for every call the path, method and body the server expects.
// The console tests mock these functions; this file keeps the functions honest.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import * as api from "@/features/platform/api";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };
let calls: Call[] = [];
let reply: { ok: boolean; status: number; json: () => Promise<unknown> } = { ok: true, status: 200, json: async () => ({ data: {} }) };

const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
  calls.push({
    url, method: init.method ?? "GET", headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  });
  return reply;
});
const last = () => calls.at(-1)!;
const pathOf = (url: string) => url.slice(url.indexOf("/platform") + "/platform".length);

/** A token whose payload carries the given roles (signature irrelevant client-side). */
const tokenWith = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`;

describe("REG-FE-PLAT platform API client", () => {
  beforeEach(() => {
    calls = [];
    localStorage.clear();
    reply = { ok: true, status: 200, json: async () => ({ data: {} }) };
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("REG-FE-PLAT-001 sends the platform token (not the clinic's) and unwraps data", async () => {
    api.platformToken.set("plat-tok");
    reply = { ok: true, status: 200, json: async () => ({ data: [{ id: "ten_1" }] }) };
    await expect(api.listClinics()).resolves.toEqual([{ id: "ten_1" }]);
    expect(last().headers.Authorization).toBe("Bearer plat-tok");
    expect(last().headers["Content-Type"]).toBe("application/json");
    expect(pathOf(last().url)).toBe("/clinics");
  });

  test("REG-FE-PLAT-002 no token: no Authorization header; a body without an envelope is returned as is", async () => {
    reply = { ok: true, status: 200, json: async () => ({ plain: true }) };
    await expect(api.listPlans()).resolves.toEqual({ plain: true });
    expect(last().headers.Authorization).toBeUndefined();
  });

  test("REG-FE-PLAT-003 a 401 signs the console out and surfaces the server's message", async () => {
    api.platformToken.set("expired");
    reply = { ok: false, status: 401, json: async () => ({ error: { message: "invalid or expired token" } }) };
    await expect(api.listClinics()).rejects.toThrow("invalid or expired token");
    expect(api.platformToken.get()).toBeNull();
  });

  test("REG-FE-PLAT-004 other failures keep the token; an unreadable body still gives a message", async () => {
    api.platformToken.set("good");
    reply = { ok: false, status: 500, json: async () => { throw new Error("not json"); } };
    await expect(api.listClinics()).rejects.toThrow("Request failed (500)");
    expect(api.platformToken.get()).toBe("good");
    reply = { ok: false, status: 400, json: async () => ({ error: { message: "that plan isn't available for this clinic type" } }) };
    await expect(api.setClinicPlan("ten_1", { plan_id: "pln_1", storage_gb_override: null, patient_limit_override: null, user_limit_override: null, branch_limit_override: null }))
      .rejects.toThrow("that plan isn't available for this clinic type");
  });

  test("REG-FE-PLAT-005 signing in stores the returned token", async () => {
    reply = { ok: true, status: 200, json: async () => ({ data: { access_token: "new-tok", email: "a@v.test" } }) };
    await api.platformLogin("a@v.test", "pw");
    expect(last()).toMatchObject({ method: "POST", body: { email: "a@v.test", password: "pw" } });
    expect(pathOf(last().url)).toBe("/auth/login");
    expect(api.platformToken.get()).toBe("new-tok");
    api.platformToken.clear();
    expect(api.platformToken.get()).toBeNull();
  });

  test("REG-FE-PLAT-006 the console role comes from the token: marketer only when the token says so", () => {
    expect(api.platformRole()).toBe("admin");
    api.platformToken.set(tokenWith({ roles: ["marketer"] }));
    expect(api.platformRole()).toBe("marketer");
    api.platformToken.set(tokenWith({ roles: ["platform_admin"] }));
    expect(api.platformRole()).toBe("admin");
    api.platformToken.set(tokenWith({}));
    expect(api.platformRole()).toBe("admin");
    api.platformToken.set("garbage-without-dots");
    expect(api.platformRole()).toBe("admin");
  });

  test("REG-FE-PLAT-007 reads go to the right GET paths", async () => {
    const reads: [() => Promise<unknown>, string][] = [
      [() => api.listFeatures(), "/features"],
      [() => api.planFeatures("pln_1"), "/plans/pln_1/features"],
      [() => api.clinicEntitlements("ten_1"), "/clinics/ten_1/entitlements"],
      [() => api.listClinics(), "/clinics"],
      [() => api.listPlans(), "/plans"],
      [() => api.clinicUsage("ten_1"), "/clinics/ten_1/usage"],
      [() => api.getClinicModules("ten_1"), "/clinics/ten_1/modules"],
      [() => api.getClinicPolicies("ten_1"), "/clinics/ten_1/policies"],
      [() => api.listPartnerLeads(), "/partner-leads"],
      [() => api.getVerifyETKey(), "/integrations/verifyet"],
      [() => api.listCampaigns(), "/crm/campaigns"],
      [() => api.getBoard("cmp_1"), "/crm/campaigns/cmp_1/board"],
      [() => api.listProspects(), "/crm/prospects?"],
      [() => api.listProspects({ q: "bole", status: "", owner: "rep_1" }), "/crm/prospects?q=bole&owner=rep_1"],
      [() => api.worklist(), "/crm/worklist?owner="],
      [() => api.worklist("rep_1"), "/crm/worklist?owner=rep_1"],
      [() => api.getProspect("pro_1"), "/crm/prospects/pro_1"],
      [() => api.checkDuplicates("Bole & Sons", "0911"), "/crm/prospects/duplicates?name=Bole%20%26%20Sons&phone=0911"],
      [() => api.listReps(), "/crm/reps"],
      [() => api.listPromos(), "/campaigns"],
      [() => api.promoQuestions("pmo_1"), "/campaigns/pmo_1/questions"],
      [() => api.promoPrizes("pmo_1"), "/campaigns/pmo_1/prizes"],
      [() => api.promoEntries("pmo_1"), "/campaigns/pmo_1/entries"],
      [() => api.promoMissed("pmo_1"), "/campaigns/pmo_1/missed"],
      [() => api.promoSignups("pmo_1"), "/campaigns/pmo_1/signups"],
    ];
    for (const [call, path] of reads) {
      await call();
      expect(pathOf(last().url)).toBe(path);
      expect(last().method).toBe("GET");
      expect(last().body).toBeUndefined();
    }
  });

  test("REG-FE-PLAT-008 writes send the method and body the server expects", async () => {
    const planBody = { code: "c", name: "N", clinic_type: "all", branch_limit: null, user_limit: 3, storage_gb: null, patient_limit: null, images_per_patient: 8, price_monthly: "0" };
    const writes: [() => Promise<unknown>, string, string, unknown?][] = [
      [() => api.setPlanFeatures("pln_1", { ai: true }), "/plans/pln_1/features", "PUT", { features: { ai: true } }],
      [() => api.setClinicEntitlement("ten_1", "ai", null), "/clinics/ten_1/entitlements", "PUT", { feature: "ai", state: null }],
      [() => api.setClinicEntitlement("ten_1", "ai", true, "sold"), "/clinics/ten_1/entitlements", "PUT", { feature: "ai", state: true, note: "sold" }],
      [() => api.provisionClinic({ clinic_name: "C", slug: "c", owner_name: "O", owner_email: "o@c", clinic_type: "dental", plan_code: "chair", modules: { dental: true } }),
        "/clinics", "POST", { clinic_name: "C", slug: "c", owner_name: "O", owner_email: "o@c", clinic_type: "dental", plan_code: "chair", modules: { dental: true } }],
      [() => api.createPlan(planBody), "/plans", "POST", planBody],
      [() => api.updatePlan("pln_1", { ...planBody, code: undefined } as never), "/plans/pln_1", "PUT", { ...planBody, code: undefined }],
      [() => api.setClinicPlan("ten_1", { plan_id: "pln_1", storage_gb_override: -1, patient_limit_override: 50, user_limit_override: null, branch_limit_override: null }),
        "/clinics/ten_1/plan", "POST", { plan_id: "pln_1", storage_gb_override: -1, patient_limit_override: 50, user_limit_override: null, branch_limit_override: null }],
      [() => api.suspendClinic("ten_1"), "/clinics/ten_1/suspend", "POST"],
      [() => api.reactivateClinic("ten_1"), "/clinics/ten_1/reactivate", "POST"],
      [() => api.setClinicModules("ten_1", { laboratory: false }), "/clinics/ten_1/modules", "PUT", { modules: { laboratory: false } }],
      [() => api.setClinicPolicies("ten_1", { doctor_registers_patients: true }), "/clinics/ten_1/policies", "PUT", { policies: { doctor_registers_patients: true } }],
      [() => api.impersonateOwner("ten_1"), "/clinics/ten_1/impersonate", "POST"],
      [() => api.setLeadStatus("prl_1", "signed"), "/partner-leads/prl_1/status", "POST", { status: "signed" }],
      [() => api.setVerifyETKey("KEY"), "/integrations/verifyet", "PUT", { key: "KEY" }],
      [() => api.clearVerifyETKey(), "/integrations/verifyet", "DELETE"],
      [() => api.createCampaign({ name: "N", phases: [] }), "/crm/campaigns", "POST", { name: "N", phases: [] }],
      [() => api.updateCampaign("cmp_1", { name: "N", phases: [] }), "/crm/campaigns/cmp_1", "PUT", { name: "N", phases: [] }],
      [() => api.setCampaignActive("cmp_1", false), "/crm/campaigns/cmp_1/active", "POST", { active: false }],
      [() => api.setPriority("pro_1", "hot"), "/crm/prospects/pro_1/priority", "POST", { priority: "hot" }],
      [() => api.setNextAction("pro_1", "call", "2026-10-05"), "/crm/prospects/pro_1/next-action", "POST", { note: "call", on: "2026-10-05" }],
      [() => api.createProspect({ clinic_name: "C" }), "/crm/prospects", "POST", { clinic_name: "C" }],
      [() => api.updateProspect("pro_1", { clinic_name: "C" }), "/crm/prospects/pro_1", "PUT", { clinic_name: "C" }],
      [() => api.assignProspect("pro_1", "rep_1"), "/crm/prospects/pro_1/assign", "POST", { owner_id: "rep_1" }],
      [() => api.enrolProspect("pro_1", "cmp_1"), "/crm/prospects/pro_1/enrol", "POST", { campaign_id: "cmp_1" }],
      [() => api.completePhase("pro_1", "done"), "/crm/prospects/pro_1/complete-phase", "POST", { note: "done" }],
      [() => api.setOutcome("pro_1", { status: "signed_up" }), "/crm/prospects/pro_1/outcome", "POST", { status: "signed_up" }],
      [() => api.reopenProspect("pro_1"), "/crm/prospects/pro_1/reopen", "POST"],
      [() => api.logTouch("pro_1", { kind: "call" }), "/crm/prospects/pro_1/touches", "POST", { kind: "call" }],
      [() => api.createRep({ email: "r@v", full_name: "R", role: "marketer", password: "p" }), "/crm/reps", "POST", { email: "r@v", full_name: "R", role: "marketer", password: "p" }],
      [() => api.setRepStatus("rep_1", "suspended"), "/crm/reps/rep_1/status", "POST", { status: "suspended" }],
      [() => api.importInbound("cmp_1"), "/crm/inbound/import", "POST", { campaign_id: "cmp_1" }],
      [() => api.savePromo("pmo_1", { title: "T" }), "/campaigns/pmo_1", "PUT", { title: "T" }],
      [() => api.openPromo("pmo_1"), "/campaigns/pmo_1/open", "POST"],
      [() => api.closePromo("pmo_1"), "/campaigns/pmo_1/close", "POST"],
      [() => api.resetPromo("pmo_1"), "/campaigns/pmo_1/reset", "POST"],
      [() => api.savePromoQuestion("pmo_1", null, { prompt: "Q", teaches: "", choices: [], sort: 1, active: true }), "/campaigns/pmo_1/questions", "POST",
        { prompt: "Q", teaches: "", choices: [], sort: 1, active: true }],
      [() => api.savePromoQuestion("pmo_1", "pmq_1", { prompt: "Q", teaches: "", choices: [], sort: 1, active: true }), "/campaigns/pmo_1/questions/pmq_1", "PUT",
        { prompt: "Q", teaches: "", choices: [], sort: 1, active: true }],
      [() => api.deletePromoQuestion("pmo_1", "pmq_1"), "/campaigns/pmo_1/questions/pmq_1", "DELETE"],
      [() => api.savePromoPrize("pmo_1", null, { label: "L", detail: "", weight: 1, sort: 1 }), "/campaigns/pmo_1/prizes", "POST", { label: "L", detail: "", weight: 1, sort: 1 }],
      [() => api.savePromoPrize("pmo_1", "pmp_1", { label: "L", detail: "", weight: 1, sort: 1 }), "/campaigns/pmo_1/prizes/pmp_1", "PUT", { label: "L", detail: "", weight: 1, sort: 1 }],
      [() => api.deletePromoPrize("pmo_1", "pmp_1"), "/campaigns/pmo_1/prizes/pmp_1", "DELETE"],
      [() => api.setPromoSignupStatus("pmo_1", "pms_1", "invited", "n"), "/campaigns/pmo_1/signups/pms_1", "POST", { status: "invited", note: "n" }],
    ];
    for (const [call, path, method, body] of writes) {
      await call();
      expect(pathOf(last().url)).toBe(path);
      expect(last().method).toBe(method);
      expect(last().body).toEqual(body);
    }
  });
});
