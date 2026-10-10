// A set of vitals, read the way a clinician reads it: first whether anything is
// wrong, then the tiles — abnormal ones loud, normal ones quiet; blood pressure as
// one tile; a field the clinic later switched off still shown if it has a value.
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { VitalCard, VitalsGrid, hhmm, numOr, worstFlag } from "@/features/clinical/components/VitalsStrip";
import type { VitalField, Vitals } from "@/features/clinical/api";

const F = (key: string, over: Partial<VitalField> = {}): VitalField => ({
  key, label: key, unit: "", decimals: 0, enabled: true, required: false, order: 0, ...over,
});

describe("REG-FE-VITALS the vitals tiles", () => {
  test("REG-FE-VITALS-001 small helpers: time, number or nothing, the more notable of two flags", () => {
    expect(hhmm(undefined)).toBe("");
    expect(hhmm("2026-10-03T09:41:00Z")).toMatch(/\d/);
    expect(numOr(undefined)).toBeUndefined();
    expect(numOr(null)).toBeUndefined();
    expect(numOr("")).toBeUndefined();
    expect(numOr("abc")).toBeUndefined();
    expect(numOr("37.5")).toBe(37.5);
    expect(worstFlag("normal", "high")).toBe("high");
    expect(worstFlag("low", "normal")).toBe("low");
    expect(worstFlag("normal", null)).toBe("normal");
    expect(worstFlag(null, null)).toBeNull();
  });

  test("REG-FE-VITALS-002 everything in range: says so, one blood-pressure tile, units, and when it was taken", () => {
    const fields = [
      F("systolic", { label: "Systolic", order: 1, low: 90, high: 140 }), F("diastolic", { label: "Diastolic", order: 2, low: 60, high: 90 }),
      F("pulse", { label: "Pulse", unit: "bpm", order: 3, low: 50, high: 100 }),
    ];
    const v: Vitals = { systolic: 120, diastolic: 80, pulse: 72, recorded_at: "2026-10-03T09:41:00Z", notes: "Calm" };
    render(<VitalsGrid vitals={v} fields={fields} />);
    expect(screen.getByText("All recorded vitals are within range")).toBeInTheDocument();
    expect(screen.getByText("BP")).toBeInTheDocument();
    expect(screen.getByText("120/80")).toBeInTheDocument();
    expect(screen.getByText("72 bpm")).toBeInTheDocument();
    expect(screen.queryByText("Systolic")).not.toBeInTheDocument();
    expect(screen.getByText("Calm")).toBeInTheDocument();
  });

  test("REG-FE-VITALS-003 an abnormal reading is counted and named in one sentence, and its tile is flagged", () => {
    const fields = [F("systolic", { order: 1, low: 90, high: 140 }), F("diastolic", { order: 2, low: 60, high: 90 }), F("spo2", { label: "SpO2", unit: "%", order: 3, low: 94 })];
    render(<VitalsGrid vitals={{ systolic: 180, diastolic: 80, spo2: 88, recorded_at: "2026-10-03T09:00:00Z" }} fields={fields} />);
    expect(screen.getByText(/2 of 2 outside the normal range/)).toBeInTheDocument();
    expect(screen.getByText(/BP, SpO2/)).toBeInTheDocument();
    expect(screen.getAllByText("high").length + screen.getAllByText("low").length).toBe(2);
  });

  test("REG-FE-VITALS-004 a blood pressure with one half missing shows a dash; a missing value shows a dash", () => {
    const fields = [F("systolic", { order: 1 }), F("diastolic", { order: 2 }), F("temp_c", { label: "Temp", unit: "°C", order: 3 })];
    render(<VitalsGrid vitals={{ systolic: 120, recorded_at: "2026-10-03T09:00:00Z" }} fields={fields} />);
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  test("REG-FE-VITALS-005 a switched-off field with a value still shows; one without does not; nothing at all shows no summary", () => {
    const { rerender } = render(
      <VitalsGrid vitals={{ pulse: 70, recorded_at: "2026-10-03T09:00:00Z" }} fields={[F("pulse", { enabled: false, label: "Pulse" }), F("spo2", { enabled: false, label: "SpO2" })]} />,
    );
    expect(screen.getByText("Pulse")).toBeInTheDocument();
    expect(screen.queryByText("SpO2")).not.toBeInTheDocument();
    rerender(<VitalsGrid vitals={{ recorded_at: "2026-10-03T09:00:00Z" }} fields={[F("pulse", { enabled: false })]} />);
    expect(screen.queryByText(/within range|outside/)).not.toBeInTheDocument();
  });

  test("REG-FE-VITALS-006 a single card: quiet when normal or unflagged, loud with its flag word when not", () => {
    const { rerender } = render(<VitalCard label="Pulse" value="72" flag="normal" />);
    expect(screen.queryByText("normal")).not.toBeInTheDocument();
    rerender(<VitalCard label="Pulse" value="130" flag="high" />);
    expect(screen.getByText("high")).toBeInTheDocument();
    rerender(<VitalCard label="Pulse" value="30" flag="low" />);
    expect(screen.getByText("low")).toBeInTheDocument();
    rerender(<VitalCard label="Pulse" value="72" />);
    expect(screen.queryByText("low")).not.toBeInTheDocument();
  });
});
