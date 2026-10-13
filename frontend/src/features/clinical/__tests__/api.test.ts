// The clinical API client: every function is a URL, a method, a body and maybe a
// query string, and a wrong one is a silent 404 or a write to the wrong record.
// The fake server records what each function SENDS; the two that talk to fetch
// directly (dictation, attachment upload) run against a stubbed fetch.
//
// Dental reaches: certificates (CertificateCard), the drug library + allergens
// (DrugLibrary, AllergenFields, AllergyDialog), history (patient profile), vitals
// form (PatientHub), and the Settings library admin. The general-clinic encounter
// functions are covered too — they are one line each and cost nothing to pin.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));

import * as api from "@/features/clinical/api";
import { tokenStore } from "@/lib/token";
import { fake, type Req } from "@/test/frontdesk";

const last = (): Req => fake.log[fake.log.length - 1];
const call = (method: string, path: string, body?: unknown) => {
  const r = last();
  expect({ method: r.method, path: r.path, body: r.body }).toEqual({ method, path, body });
};

beforeEach(() => fake.reset());

describe("REG-FE-CLINAPI certificates", () => {
  test("REG-FE-CLINAPI-001 list, issue and void a certificate", async () => {
    fake.on("GET", "/patients/:id/certificates", { items: [{ id: "c1" }] });
    expect(await api.listCertificates("pat_1")).toEqual({ items: [{ id: "c1" }] });
    call("GET", "/patients/pat_1/certificates");
    const body = { kind: "sick_leave" as const, show_diagnosis: false, rest_days: 3, rest_from: "2026-10-01", notes: "x" };
    await api.issueCertificate("pat_1", body);
    call("POST", "/patients/pat_1/certificates", body);
    await api.voidCertificate("cert_9", "Wrong patient");
    call("POST", "/certificates/cert_9/void", { reason: "Wrong patient" });
  });
});

describe("REG-FE-CLINAPI drug and allergen library", () => {
  test("REG-FE-CLINAPI-002 searchDrugs: no query, search only, all only, both", async () => {
    await api.searchDrugs();
    expect(last().path).toBe("/drugs");
    await api.searchDrugs("amox");
    expect(last().path).toBe("/drugs?search=amox");
    await api.searchDrugs("", true);
    expect(last().path).toBe("/drugs?all=1");
    await api.searchDrugs("co amox&x", true);
    expect(last().route).toBe("/drugs");
    expect(Object.fromEntries(last().query)).toEqual({ search: "co amox&x", all: "1" });
  });

  test("REG-FE-CLINAPI-003 create, update and delete a drug", async () => {
    const body = { name: "Amoxicillin", default_dose: "500mg", allergen_ids: ["alg_1"] };
    await api.createDrug(body);
    call("POST", "/drugs", body);
    await api.updateDrug("drg_1", { ...body, is_active: false });
    call("PUT", "/drugs/drg_1", { ...body, is_active: false });
    await api.deleteDrug("drg_1");
    call("DELETE", "/drugs/drg_1");
  });

  test("REG-FE-CLINAPI-004 listAllergens: no query, search, all", async () => {
    await api.listAllergens();
    expect(last().path).toBe("/allergens");
    await api.listAllergens("pen");
    expect(last().path).toBe("/allergens?search=pen");
    await api.listAllergens(undefined, true);
    expect(last().path).toBe("/allergens?all=1");
    await api.listAllergens("pen", true);
    expect(last().path).toBe("/allergens?search=pen&all=1");
  });

  test("REG-FE-CLINAPI-005 create (with and without defaults), update and delete an allergen", async () => {
    await api.createAllergen("Penicillin", { default_reaction: "Rash", default_severity: "severe" });
    call("POST", "/allergens", { name: "Penicillin", default_reaction: "Rash", default_severity: "severe" });
    await api.createAllergen("Latex");
    call("POST", "/allergens", { name: "Latex" });
    await api.updateAllergen("alg_1", { name: "Penicillins", is_active: true });
    call("PUT", "/allergens/alg_1", { name: "Penicillins", is_active: true });
    await api.deleteAllergen("alg_1");
    call("DELETE", "/allergens/alg_1");
  });
});

describe("REG-FE-CLINAPI patient record and vitals form", () => {
  test("REG-FE-CLINAPI-006 history, story, visit, vitals", async () => {
    await api.listHistory("pat_1");
    call("GET", "/encounters?patient=pat_1");
    await api.patientStory("pat_1");
    call("GET", "/patients/pat_1/story");
    await api.getVisit("q_1");
    call("GET", "/visits/q_1");
    await api.recordVitals("q_1", "pat_1", { branch_id: "br_main", pulse: 80 });
    call("POST", "/visits/q_1/vitals?patient=pat_1", { branch_id: "br_main", pulse: 80 });
  });

  test("REG-FE-CLINAPI-007 the vitals form config is read and saved whole", async () => {
    await api.getVitalFields();
    call("GET", "/vital-fields");
    const f: api.VitalField = { key: "pulse", label: "Pulse", unit: "bpm", decimals: 0, enabled: true, required: false, order: 1 };
    await api.saveVitalFields([f]);
    call("PUT", "/vital-fields", { fields: [f] });
  });

  test("REG-FE-CLINAPI-008 vitalFlag: low, high, normal inside a range, null with no range", () => {
    const f = { key: "p", label: "P", unit: "", decimals: 0, enabled: true, required: false, order: 0 };
    expect(api.vitalFlag({ ...f, low: 60, high: 100 }, 59)).toBe("low");
    expect(api.vitalFlag({ ...f, low: 60, high: 100 }, 101)).toBe("high");
    expect(api.vitalFlag({ ...f, low: 60, high: 100 }, 60)).toBe("normal");
    expect(api.vitalFlag({ ...f, high: 100 }, 20)).toBe("normal");
    expect(api.vitalFlag({ ...f, low: 0 }, 0)).toBe("normal");
    expect(api.vitalFlag(f, 999)).toBeNull();
  });
});

describe("REG-FE-CLINAPI encounter workspace (general clinic)", () => {
  test("REG-FE-CLINAPI-009 open, read, note, diagnoses, prescriptions, sign, set aside, assist", async () => {
    await api.openEncounter("q_1");
    call("POST", "/encounters", { queue_entry_id: "q_1" });
    await api.getWorkspace("enc_1");
    call("GET", "/encounters/enc_1");
    await api.saveNote("enc_1", { plan: "Review" });
    call("PUT", "/encounters/enc_1/note", { plan: "Review" });
    await api.addDiagnosis("enc_1", { code: "K04.7", is_primary: true });
    call("POST", "/encounters/enc_1/diagnoses", { code: "K04.7", is_primary: true });
    await api.removeDiagnosis("enc_1", "dx_1");
    call("DELETE", "/encounters/enc_1/diagnoses/dx_1");
    await api.addMedication("enc_1", { drug_name: "Amox", override_reason: "tolerated before" });
    call("POST", "/encounters/enc_1/prescriptions", { drug_name: "Amox", override_reason: "tolerated before" });
    await api.removeMedication("enc_1", "rx_1");
    call("DELETE", "/encounters/enc_1/prescriptions/rx_1");
    await api.signEncounter("enc_1");
    call("POST", "/encounters/enc_1/sign");
    await api.setAside("enc_1");
    call("POST", "/encounters/enc_1/set-aside");
    await api.runAssist("enc_1");
    call("POST", "/encounters/enc_1/assist");
  });

  test("REG-FE-CLINAPI-010 outside-lab referrals: create, result, cancel, sign upload", async () => {
    await api.createLabReferral("enc_1", { tests: "CBC", indication: "pre-op" });
    call("POST", "/encounters/enc_1/lab-referrals", { tests: "CBC", indication: "pre-op" });
    await api.recordLabReferralResult("ref_1", { summary: "normal" });
    call("POST", "/lab-referrals/ref_1/result", { summary: "normal" });
    await api.cancelLabReferral("ref_1");
    call("POST", "/lab-referrals/ref_1/cancel");
    await api.signReferralUpload("ref_1", { filename: "a.pdf", type: "application/pdf" });
    call("POST", "/lab-referrals/ref_1/result/sign", { filename: "a.pdf", type: "application/pdf" });
  });

  test("REG-FE-CLINAPI-011 myBoard: provider/from/to only when given", async () => {
    await api.myBoard();
    expect(last().path).toBe("/encounters/board");
    await api.myBoard("usr_1", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
    expect(last().route).toBe("/encounters/board");
    expect(Object.fromEntries(last().query)).toEqual({ provider: "usr_1", from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" });
  });

  test("REG-FE-CLINAPI-012 diagnosis catalog and categories", async () => {
    await api.searchCatalog();
    expect(last().path).toBe("/diagnosis-catalog");
    await api.searchCatalog({ search: "car", category: "cat_1", all: true });
    expect(last().path).toBe("/diagnosis-catalog?search=car&category=cat_1&all=1");
    await api.listDiagnosisCategories();
    call("GET", "/diagnosis-categories");
    await api.createCategory({ name: "Dental", sort_order: 2 });
    call("POST", "/diagnosis-categories", { name: "Dental", sort_order: 2 });
    await api.updateCategory("cat_1", { name: "Oral", is_active: false });
    call("PUT", "/diagnosis-categories/cat_1", { name: "Oral", is_active: false });
    await api.deleteCategory("cat_1");
    call("DELETE", "/diagnosis-categories/cat_1");
    await api.createCatalogEntry({ category_id: "cat_1", code: "K02", name: "Caries" });
    call("POST", "/diagnosis-catalog", { category_id: "cat_1", code: "K02", name: "Caries" });
    await api.updateCatalogEntry("ce_1", { category_id: "cat_1", name: "Caries", is_active: true });
    call("PUT", "/diagnosis-catalog/ce_1", { category_id: "cat_1", name: "Caries", is_active: true });
    await api.deleteCatalogEntry("ce_1");
    call("DELETE", "/diagnosis-catalog/ce_1");
  });
});

// ---- the two functions that call fetch directly ----

let fetchSpy: ReturnType<typeof vi.fn>;
function respond(ok: boolean, json: unknown, jsonThrows = false) {
  fetchSpy.mockResolvedValueOnce({ ok, json: jsonThrows ? () => Promise.reject(new Error("not json")) : () => Promise.resolve(json) });
}
beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.clear();
});

describe("REG-FE-CLINAPI voice dictation", () => {
  test("REG-FE-CLINAPI-013 posts the clip with its type and the bearer token; returns the text", async () => {
    tokenStore.set("tok_1");
    respond(true, { data: { text: "pain lower left" } });
    const blob = new Blob(["x"], { type: "audio/ogg" });
    expect(await api.transcribe(blob)).toBe("pain lower left");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/transcribe$/);
    expect(init).toMatchObject({ method: "POST", credentials: "include", body: blob,
      headers: { "Content-Type": "audio/ogg", Authorization: "Bearer tok_1" } });
  });

  test("REG-FE-CLINAPI-014 no type → audio/webm, no token → empty bearer, no text → empty string", async () => {
    respond(true, {});
    expect(await api.transcribe(new Blob(["x"]))).toBe("");
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({ "Content-Type": "audio/webm", Authorization: "Bearer " });
  });

  test("REG-FE-CLINAPI-015 errors: disabled, server message, unreadable body", async () => {
    respond(false, { error: { code: "TRANSCRIPTION_DISABLED" } });
    await expect(api.transcribe(new Blob(["x"]))).rejects.toThrow("Voice dictation isn't enabled for this clinic.");
    respond(false, { error: { code: "X", message: "Too long" } });
    await expect(api.transcribe(new Blob(["x"]))).rejects.toThrow("Too long");
    respond(false, null, true);
    await expect(api.transcribe(new Blob(["x"]))).rejects.toThrow("Could not transcribe the audio.");
  });
});

describe("REG-FE-CLINAPI direct upload of an attachment", () => {
  const file = new File(["%PDF"], "result.pdf", { type: "application/pdf" });

  test("REG-FE-CLINAPI-016 presigned PUT (R2): raw body with its content type; the key is returned, no URL", async () => {
    respond(true, null);
    const out = await api.uploadToTarget({ method: "put", url: "https://r2/x", fields: {}, key: "k/1" }, file);
    expect(fetchSpy).toHaveBeenCalledWith("https://r2/x", { method: "PUT", body: file, headers: { "Content-Type": "application/pdf" }, signal: expect.any(AbortSignal) });
    expect(out).toEqual({ key: "k/1", url: "", name: "result.pdf", mime: "application/pdf" });
    respond(false, null);
    await expect(api.uploadToTarget({ method: "PUT", url: "https://r2/x", fields: {}, key: "k" }, file)).rejects.toThrow("Upload failed");
  });

  test("REG-FE-CLINAPI-017 presigned POST (Cloudinary): signed fields then the file; public id and secure URL win", async () => {
    respond(true, { public_id: "pid", secure_url: "https://s", url: "http://u" });
    const out = await api.uploadToTarget({ method: "POST", url: "https://c/up", fields: { sig: "abc", ts: "1" }, key: "k" }, file);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://c/up");
    expect(init.method).toBe("POST");
    const fd = init.body as FormData;
    expect([...fd.keys()]).toEqual(["sig", "ts", "file"]);
    expect(fd.get("sig")).toBe("abc");
    expect((fd.get("file") as File).name).toBe("result.pdf");
    expect(out).toEqual({ key: "pid", url: "https://s", name: "result.pdf", mime: "application/pdf" });
  });

  test("REG-FE-CLINAPI-018 POST fallbacks: no method means POST, no fields, key and plain url used, failure throws", async () => {
    respond(true, { url: "http://u" });
    const out = await api.uploadToTarget({ method: "", url: "https://c/up", fields: undefined as never, key: "k/2" }, file);
    expect(fetchSpy.mock.calls[0][1].method).toBe("POST");
    expect(out).toEqual({ key: "k/2", url: "http://u", name: "result.pdf", mime: "application/pdf" });
    respond(false, {});
    await expect(api.uploadToTarget({ method: "POST", url: "https://c/up", fields: {}, key: "k" }, file)).rejects.toThrow("Upload failed");
  });
});
