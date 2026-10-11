// One row on the reception list. What it must get right: the time the desk reads
// down (the booking on Expected, the arrival everywhere else), how late someone is,
// how long they have waited, and the three money/coverage facts that change what
// happens next — a free follow-up still inside its window, money owed (agreed credit
// looks different from an uncollected charge), and treatment not yet billed.
// Times are built relative to "now", so the tests hold at any hour in any zone.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import { ArrivalRow, clock, coveredNow, day, minutesSince } from "@/features/scheduling/reception/ArrivalList";
import type { ReceptionPatient } from "@/features/scheduling/api";

const MIN = 60_000;
const DAY = 864e5;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();

const P = (over: Partial<ReceptionPatient> = {}): ReceptionPatient => ({
  patient_id: "pat_a", name: "Almaz Haile", mrn: "MRN-1", age: 34, sex: "female",
  is_followup: false, late_minutes: 0, ...over,
});

type Lens = "expected" | "waiting" | "seen" | "settle";
function row(p: ReceptionPatient, lens: Lens = "expected", selected = false) {
  const onPick = vi.fn();
  render(<ArrivalRow p={p} lens={lens} selected={selected} onPick={onPick} />);
  return { onPick, btn: screen.getByRole("button") };
}

describe("REG-FE-ARRIVAL reception arrival row", () => {
  test("REG-FE-ARRIVAL-001 expected: booking time, name, card number, age+sex, clinician and reason", () => {
    const starts = at(30 * MIN);
    const { btn } = row(P({ starts_at: starts, provider_name: "Dr Sara", reason: "Cleaning" }));
    expect(btn).toHaveTextContent(clock(starts));
    expect(btn).toHaveTextContent("Almaz Haile");
    expect(btn).toHaveTextContent("MRN-1");
    expect(btn).toHaveTextContent("34y F · Dr Sara · Cleaning");
    expect(btn).not.toHaveTextContent(/late/);
    expect(btn).not.toHaveAttribute("aria-current");
  });

  test("REG-FE-ARRIVAL-002 expected and late: says how many minutes late", () => {
    const { btn } = row(P({ starts_at: at(-20 * MIN), late_minutes: 20 }));
    expect(btn).toHaveTextContent("20 min late");
  });

  test("REG-FE-ARRIVAL-003 lateness is only an Expected fact; waiting shows the arrival time and the wait", () => {
    const since = at(-25 * MIN);
    const { btn } = row(P({ starts_at: at(-40 * MIN), late_minutes: 40, waiting_since: since }), "waiting");
    expect(btn).not.toHaveTextContent(/min late/);
    expect(btn).toHaveTextContent(clock(since));
    expect(btn).toHaveTextContent(/waiting 25 min/);
  });

  test("REG-FE-ARRIVAL-004 seen: arrival time but no running wait", () => {
    const since = at(-90 * MIN);
    const { btn } = row(P({ waiting_since: since, finished: true }), "seen");
    expect(btn).toHaveTextContent(clock(since));
    expect(btn).not.toHaveTextContent(/waiting/);
  });

  test("REG-FE-ARRIVAL-005 no age and no sex: nothing invented", () => {
    const { btn } = row(P({ age: 0, sex: undefined }));
    expect(btn).not.toHaveTextContent(/\dy/);
    expect(btn.querySelector("p")?.textContent).toBe("");
  });

  test("REG-FE-ARRIVAL-006 a follow-up inside its window is badged free, until the day it ends", () => {
    const until = at(5 * DAY);
    const { btn } = row(P({ is_followup: true, free_until: until }));
    expect(btn).toHaveTextContent(`Free follow-up · until ${day(until)}`);
  });

  test("REG-FE-ARRIVAL-007 an expired window, or a booking that is not a follow-up, is not free", () => {
    row(P({ is_followup: true, free_until: at(-DAY) }));
    expect(screen.queryByText(/Free follow-up/)).not.toBeInTheDocument();
  });

  test("REG-FE-ARRIVAL-008 uncollected debt reads 'Owes', with its age", () => {
    const { btn } = row(P({ owed: "300", owed_oldest_days: 12 }));
    expect(btn).toHaveTextContent("Owes 300 ETB · 12d");
  });

  test("REG-FE-ARRIVAL-009 agreed credit reads 'Billed later', not as a surprise debt", () => {
    const { btn } = row(P({ owed: "300", owed_agreed: true }), "waiting");
    expect(btn).toHaveTextContent("Billed later · 300 ETB");
    expect(btn).not.toHaveTextContent(/Owes/);
  });

  test("REG-FE-ARRIVAL-010 on To settle, any debt is simply 'To collect', without the age", () => {
    const { btn } = row(P({ owed: "800", owed_agreed: true, owed_oldest_days: 3, finished: true }), "settle");
    expect(btn).toHaveTextContent("To collect 800 ETB");
    expect(btn).not.toHaveTextContent(/3d|Billed later/);
  });

  test("REG-FE-ARRIVAL-011 treatment not yet sent to the cashier is flagged even when nothing is owed", () => {
    const { btn } = row(P({ owed: "0", unbilled: "1500" }), "seen");
    expect(btn).toHaveTextContent(/Not yet billed 1,?500 ETB/);
    expect(btn).not.toHaveTextContent(/Owes/);
  });

  test("REG-FE-ARRIVAL-012 a zero balance and rounding-dust unbilled show no badges", () => {
    const { btn } = row(P({ owed: "0", unbilled: "0.004" }));
    expect(btn).not.toHaveTextContent(/Owes|Not yet billed|Free/);
  });

  test("REG-FE-ARRIVAL-013 the selected row says so; clicking picks it", async () => {
    const { btn, onPick } = row(P(), "expected", true);
    expect(btn).toHaveAttribute("aria-current", "true");
    await userEvent.click(btn);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-ARRIVAL-014 coveredNow: needs both the follow-up flag and a window not yet passed", () => {
    expect(coveredNow(P({ is_followup: true, free_until: at(DAY) }))).toBe(true);
    expect(coveredNow(P({ is_followup: true, free_until: at(-MIN) }))).toBe(false);
    expect(coveredNow(P({ is_followup: true }))).toBe(false);
    expect(coveredNow(P({ is_followup: false, free_until: at(DAY) }))).toBe(false);
  });

  test("REG-FE-ARRIVAL-015 minutesSince never goes negative for a clock that is slightly ahead", () => {
    expect(minutesSince(at(-10 * MIN))).toBe(10);
    expect(minutesSince(at(5 * MIN))).toBe(0);
  });

  test("REG-FE-ARRIVAL-016 a treatment visit is tagged, shows its course and visit number, and has no booking time", () => {
    const { btn } = row(P({ treatment_visit: true, provider_name: undefined, reason: "Root canal · visit 2 of 3" }));
    expect(btn).toHaveTextContent("Treatment visit");
    expect(btn).toHaveTextContent("34y F · Root canal · visit 2 of 3");
    // Nothing was booked, so there is no clock and nothing can be "late".
    expect(btn).not.toHaveTextContent(/\d{1,2}:\d{2}/);
    expect(btn).not.toHaveTextContent(/min late/);
  });

  test("REG-FE-ARRIVAL-017 an ordinary booking is not tagged as a treatment visit", () => {
    const { btn } = row(P({ starts_at: at(30 * MIN), reason: "Cleaning" }));
    expect(btn).not.toHaveTextContent("Treatment visit");
  });
});
