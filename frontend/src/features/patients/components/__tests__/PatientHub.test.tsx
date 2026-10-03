// The pieces of the patient page that answer "what is true right now".
//
// What they must get right: the right-now strip shows a tile only when it has
// something to say (in the clinic, owes money, lab work outstanding, next booking,
// last visit) and says it in the words the desk acts on; the observations card
// says when the numbers are not from today; the lab panel lists every order with
// its results and flags, and says plainly when there has never been one; and each
// job is offered the lenses it qualifies for, in the right order.
import { screen, within } from "@testing-library/react";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const patients = vi.hoisted(() => ({ patientLabs: vi.fn() }));
const clinical = vi.hoisted(() => ({ getVitalFields: vi.fn() }));
vi.mock("@/features/patients/api", async (orig) => ({ ...(await orig<object>()), ...patients }));
vi.mock("@/features/clinical/api", async (orig) => ({ ...(await orig<object>()), ...clinical }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});

import { LabHistoryPanel, LastVitalsCard, LENS_LABEL, RightNow, lensesFor } from "../PatientHub";
import type { PatientLabOrder, PatientOverview } from "@/features/patients/api";
import { freezeToday, renderUI } from "@/test/render";

const T = "2026-10-03";
/** A local wall-clock instant on the frozen day (or around it), as the server would send it. */
const at = (dayOffset: number, h: number, m = 0) => {
  const [y, mo, d] = T.split("-").map(Number);
  return new Date(y, mo - 1, d + dayOffset, h, m).toISOString();
};
const tiles = (c: HTMLElement) => c.querySelectorAll(".border-l-4");
const can = (...perms: string[]) => (p: string) => perms.includes(p);

describe("REG-FE-PHUB the patient hub: right now, observations, laboratory, lenses", () => {
  beforeEach(() => {
    freezeToday(T, 9);
    patients.patientLabs.mockReset();
    clinical.getVitalFields.mockReset().mockResolvedValue([
      { key: "systolic", label: "Systolic", unit: "mmHg", decimals: 0, enabled: true, required: false, order: 1 },
      { key: "diastolic", label: "Diastolic", unit: "mmHg", decimals: 0, enabled: true, required: false, order: 2 },
      { key: "pulse", label: "Pulse", unit: "bpm", decimals: 0, enabled: true, required: false, order: 3 },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  /* ------------------------------------------------------------- RightNow */

  test("REG-FE-PHUB-001 loading: a placeholder; no overview: nothing; an ordinary day: nothing", () => {
    const { container, rerender } = render(<RightNow loading o={undefined} />);
    expect(container.querySelector(".animate-pulse, [class*=skeleton]")).not.toBeNull();
    rerender(<RightNow loading={false} o={undefined} />);
    expect(container).toBeEmptyDOMElement();
    // Nothing owed (below half a cent), no lab work, nothing booked: no tiles at all.
    rerender(<RightNow loading={false} o={{ money: { owed: "0.001", oldest_days: 0, all_agreed: false },
      labs: { on_the_bench: 0, to_validate: 0, critical: 0 } }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("REG-FE-PHUB-002 waiting in the clinic: how long, where and with whom", () => {
    const o: PatientOverview = { here_now: { kind: "queue", state: "waiting", where: "OPD 2", provider: "Dr Hana",
      since: new Date(Date.now() - 75 * 60000).toISOString() } as PatientOverview["here_now"] };
    const { container } = render(<RightNow loading={false} o={o} />);
    expect(tiles(container)).toHaveLength(1);
    expect(screen.getByText("In the clinic now")).toBeInTheDocument();
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    expect(screen.getByText("OPD 2 · 1h 15m so far · Dr Hana")).toBeInTheDocument();
  });

  test("REG-FE-PHUB-003 queue states: with the doctor, called; minutes under an hour; a future clock never goes negative", () => {
    const here = (state: string, minsAgo: number) => ({ here_now: { kind: "queue", state,
      since: new Date(Date.now() - minsAgo * 60000).toISOString() } as PatientOverview["here_now"] });
    const { rerender } = render(<RightNow loading={false} o={here("in_consult", 12)} />);
    expect(screen.getByText("With the doctor")).toBeInTheDocument();
    expect(screen.getByText("12 min so far")).toBeInTheDocument();
    rerender(<RightNow loading={false} o={here("called", -5)} />);
    expect(screen.getByText("Called")).toBeInTheDocument();
    expect(screen.getByText("0 min so far")).toBeInTheDocument();
  });

  test("REG-FE-PHUB-004 admitted: the bed, nights (singular and plural) and since when", () => {
    const bed = (nights: number | undefined, where?: string) => ({ here_now: { kind: "bed", state: "admitted",
      where, nights, since: at(-2, 10) } as PatientOverview["here_now"] });
    const { rerender } = render(<RightNow loading={false} o={bed(2, "Ward A · Bed 3")} />);
    expect(screen.getByText("Admitted")).toBeInTheDocument();
    expect(screen.getByText("Ward A · Bed 3")).toBeInTheDocument();
    expect(screen.getByText(/^2 nights · since (Oct 1|1 Oct)$/)).toBeInTheDocument();
    rerender(<RightNow loading={false} o={bed(1)} />);
    expect(screen.getByText("In a bed")).toBeInTheDocument();
    expect(screen.getByText(/^1 night · since/)).toBeInTheDocument();
    rerender(<RightNow loading={false} o={bed(undefined)} />);
    expect(screen.getByText(/^0 nights · since/)).toBeInTheDocument();
  });

  test("REG-FE-PHUB-005 owes money: the amount in ETB and how old the oldest charge is", () => {
    const money = (owed: string, oldest_days: number, all_agreed = false) => ({ money: { owed, oldest_days, all_agreed } });
    const { container, rerender } = render(<RightNow loading={false} o={money("1250", 3)} />);
    expect(screen.getByText("Owes")).toBeInTheDocument();
    expect(screen.getByText(/^ETB 1,250\.00$/)).toBeInTheDocument();
    expect(screen.getByText("oldest 3 days")).toBeInTheDocument();
    expect(tiles(container)[0].className).toMatch(/destructive/);
    rerender(<RightNow loading={false} o={money("40", 1)} />);
    expect(screen.getByText("oldest 1 day")).toBeInTheDocument();
    rerender(<RightNow loading={false} o={money("40", 0)} />);
    expect(screen.getByText("raised today")).toBeInTheDocument();
    // Treat-now-bill-later that everyone agreed to is not an alarm.
    rerender(<RightNow loading={false} o={money("40", 0, true)} />);
    expect(screen.getByText("Billed later — agreed")).toBeInTheDocument();
    expect(tiles(container)[0].className).not.toMatch(/destructive/);
  });

  test("REG-FE-PHUB-006 laboratory: a critical result leads; otherwise what is outstanding and where", () => {
    const labs = (critical: number, on_the_bench: number, to_validate: number) =>
      ({ labs: { critical, on_the_bench, to_validate } });
    const { rerender } = render(<RightNow loading={false} o={labs(2, 1, 0)} />);
    expect(screen.getByText("Critical result")).toBeInTheDocument();
    expect(screen.getByText("2 flagged")).toBeInTheDocument();
    expect(screen.getByText("1 on the bench")).toBeInTheDocument();
    rerender(<RightNow loading={false} o={labs(0, 2, 3)} />);
    expect(screen.getByText("Laboratory")).toBeInTheDocument();
    expect(screen.getByText("5 outstanding")).toBeInTheDocument();
    expect(screen.getByText("2 on the bench · 3 to validate")).toBeInTheDocument();
    rerender(<RightNow loading={false} o={labs(0, 0, 1)} />);
    expect(screen.getByText("1 to validate")).toBeInTheDocument();
  });

  test("REG-FE-PHUB-007 next booking and last visit: follow-up named, open visit named, notes joined", () => {
    const o: PatientOverview = {
      next_appointment: { starts_at: at(5, 10, 30), is_followup: true, department: "Dental", provider: "Dr Selam" },
      last_visit: { at: at(-10, 9), open: false, diagnosis: "Caries", provider: "Dr Selam" },
    };
    const { container, rerender } = render(<RightNow loading={false} o={o} />);
    expect(tiles(container)).toHaveLength(2);
    expect(screen.getByText("Next — follow-up")).toBeInTheDocument();
    expect(screen.getByText(/Oct 8|8 Oct/)).toBeInTheDocument();
    expect(screen.getByText("Dental · Dr Selam")).toBeInTheDocument();
    expect(screen.getByText("Last seen")).toBeInTheDocument();
    expect(screen.getByText("Caries · Dr Selam")).toBeInTheDocument();
    rerender(<RightNow loading={false} o={{
      next_appointment: { starts_at: at(1, 9), is_followup: false },
      last_visit: { at: at(0, 8), open: true },
    }} />);
    expect(screen.getByText("Next booked")).toBeInTheDocument();
    expect(screen.getByText("Visit open now")).toBeInTheDocument();
  });

  /* --------------------------------------------------------- LastVitalsCard */

  test("REG-FE-PHUB-008 observations: nothing recorded says so", () => {
    renderUI(<LastVitalsCard o={{}} />);
    expect(screen.getByText("Nothing recorded yet.")).toBeInTheDocument();
  });

  test("REG-FE-PHUB-009 observations from this morning: the values, BP as one reading, no staleness note", async () => {
    renderUI(<LastVitalsCard o={{ vitals: { recorded_at: at(0, 8, 15), systolic: 128, diastolic: 82, pulse: 76 } }} />);
    expect(await screen.findByText("128/82")).toBeInTheDocument();
    expect(screen.getByText(/76 bpm/)).toBeInTheDocument();
    expect(screen.queryByText(/not from today/)).not.toBeInTheDocument();
  });

  test("REG-FE-PHUB-010 observations from two days ago are marked as not from today", async () => {
    renderUI(<LastVitalsCard o={{ vitals: { recorded_at: at(-2, 8), pulse: 90 } }} />);
    expect(await screen.findByText(/not from today/)).toBeInTheDocument();
  });

  test.fails("REG-FE-PHUB-011 KNOWN BUG NEW-PROF-2 observations taken last night are not from today, and must say so", async () => {
    // Recorded yesterday at 20:00, read today at 09:00: 13 hours old, a different
    // day. The card's own words are "not from today", but it only checks a 24 h
    // window (PatientHub.tsx:169), so last night's numbers read as this morning's.
    renderUI(<LastVitalsCard o={{ vitals: { recorded_at: at(-1, 20), pulse: 90 } }} />);
    expect(await screen.findByText(/not from today/)).toBeInTheDocument();
  });

  /* -------------------------------------------------------- LabHistoryPanel */

  test("REG-FE-PHUB-012 lab history: while loading a placeholder; never ordered says so", async () => {
    let resolve!: (v: PatientLabOrder[]) => void;
    patients.patientLabs.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { container } = renderUI(<LabHistoryPanel patientId="pat_1" />);
    expect(container.querySelector(".animate-pulse, [class*=skeleton]")).not.toBeNull();
    resolve([]);
    expect(await screen.findByText("No tests have ever been ordered for this patient.")).toBeInTheDocument();
    expect(patients.patientLabs).toHaveBeenCalledWith("pat_1");
  });

  test("REG-FE-PHUB-013 lab history: orders, test states in plain words, results with units, flags and ranges", async () => {
    patients.patientLabs.mockResolvedValue([
      { order_no: 41, priority: "urgent", created_at: at(0, 8), items: [
        { sample_no: 901, test_name: "CBC", status: "resulted", results: [
          { name: "Hb", value: "6.1", unit: "g/dL", flag: "critical" },
          { name: "WBC", value: "12", unit: "10^9/L", flag: "high" },
          { name: "PLT", value: "250", flag: "normal", ref_low: "150", ref_high: "400" },
          { name: "MCV", value: "", flag: "normal", ref_low: "80" },
          { name: "MCH", value: "29", flag: "normal" },
        ] },
        { sample_no: 902, test_name: "Malaria RDT", status: "in_process", results: [] },
        { sample_no: 903, test_name: "Widal", status: "mystery_state", results: [] },
      ] },
      { order_no: 40, priority: "routine", created_at: at(-30, 8), items: [
        { sample_no: 800, test_name: "FBS", status: "validated", results: [{ name: "Glucose", value: "5.2", unit: "mmol/L", flag: "low" }] },
        { sample_no: 801, test_name: "Lipids", status: "cancelled", results: [] },
      ] },
    ] satisfies PatientLabOrder[]);
    renderUI(<LabHistoryPanel patientId="pat_1" />);
    expect(await screen.findByText("Order #41")).toBeInTheDocument();
    // Outstanding = not validated and not cancelled: the CBC, the RDT and the unknown state.
    expect(screen.getByText("3 outstanding")).toBeInTheDocument();
    expect(screen.getByText(/· urgent$/)).toBeInTheDocument();
    expect(screen.getByText("awaiting validation")).toBeInTheDocument();
    expect(screen.getByText("on the bench")).toBeInTheDocument();
    expect(screen.getByText("mystery_state")).toBeInTheDocument();
    expect(screen.getByText("validated")).toBeInTheDocument();
    expect(screen.getByText("cancelled")).toBeInTheDocument();
    const hb = screen.getByText("Hb").closest("tr")!;
    expect(within(hb).getByText("6.1 g/dL")).toHaveClass("text-destructive");
    expect(within(hb).getByText("critical")).toBeInTheDocument();
    expect(within(screen.getByText("WBC").closest("tr")!).getByText("12 10^9/L")).toHaveClass("text-amber-700");
    expect(within(screen.getByText("PLT").closest("tr")!).getByText("150–400")).toBeInTheDocument();
    const mcv = screen.getByText("MCV").closest("tr")!;
    expect(within(mcv).getByText("—")).toBeInTheDocument();
    expect(within(mcv).getByText("80–")).toBeInTheDocument();
    expect(screen.getByText("Glucose").closest("tr")).toHaveTextContent("low");
    // A routine order does not announce its priority.
    expect(screen.getByText("Order #40").nextSibling?.textContent).not.toMatch(/routine/);
    expect(screen.queryByText(/Showing the 12 most recent/)).not.toBeInTheDocument();
  });

  test("REG-FE-PHUB-014 lab history: more than 12 orders shows the newest 12 and links to the worklist", async () => {
    patients.patientLabs.mockResolvedValue(Array.from({ length: 13 }, (_, i) => ({
      order_no: 100 - i, priority: "routine", created_at: at(-i, 8),
      items: [{ sample_no: 500 + i, test_name: `T${i}`, status: "validated", results: [] }],
    })));
    renderUI(<LabHistoryPanel patientId="pat_1" />);
    expect(await screen.findByText("Order #100")).toBeInTheDocument();
    expect(screen.getByText("Order #89")).toBeInTheDocument();
    expect(screen.queryByText("Order #88")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lab worklist" })).toHaveAttribute("href", "/lab");
    expect(screen.queryByText(/outstanding/)).not.toBeInTheDocument();
  });

  test.fails("REG-FE-PHUB-015 KNOWN BUG NEW-PROF-3 a lab history that fails to load must not claim no test was ever ordered", async () => {
    // LabHistoryPanel (PatientHub.tsx:222-225) checks isLoading and then length:
    // a failed request leaves data undefined, so the panel states as fact that this
    // patient has never had a test — the UX-1 pattern.
    patients.patientLabs.mockRejectedValue(new Error("502"));
    renderUI(<LabHistoryPanel patientId="pat_1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("No tests have ever been ordered for this patient.")).not.toBeInTheDocument();
  });

  /* ---------------------------------------------------------------- lenses */

  test("REG-FE-PHUB-016 lensesFor: each job gets its own lens; an owner gets all three in care, desk, lab order", () => {
    expect(lensesFor(can())).toEqual([]);
    expect(lensesFor(can("triage.manage"))).toEqual(["care"]);
    expect(lensesFor(can("encounter.manage"))).toEqual(["care"]);
    for (const p of ["payment.collect", "payment.charge", "billing.manage", "appointment.manage", "queue.manage"]) {
      expect(lensesFor(can(p))).toEqual(["desk"]);
    }
    for (const p of ["lab.process", "lab.validate", "lab.manage"]) expect(lensesFor(can(p))).toEqual(["lab"]);
    expect(lensesFor(can("lab.manage", "queue.manage", "encounter.manage"))).toEqual(["care", "desk", "lab"]);
    expect(LENS_LABEL).toEqual({ care: "Care", desk: "Front desk", lab: "Laboratory" });
  });
});
