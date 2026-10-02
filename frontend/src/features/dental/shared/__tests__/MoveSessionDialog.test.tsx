// Moving a treatment session to another day. What matters: only a date is sent,
// the quick offsets land on the right day, a past day and a clash warn but never
// block, a half-typed Ethiopian date cannot be submitted, and failures are said.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ rescheduleSession: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));

import { MoveSessionDialog, type MoveSessionDialogProps } from "@/features/dental/shared/MoveSessionDialog";
import { AppError } from "@/lib/api-client";
import { formatEthiopian } from "@/lib/ethiopian";
import { freezeToday, renderUI } from "@/test/render";

const T = "2026-08-12";
const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const long = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function dialog(props: Partial<MoveSessionDialogProps> = {}) {
  const onClose = vi.fn(), onMoved = vi.fn();
  const r = renderUI(
    <MoveSessionDialog patientId="pat_1" sessionId="s2" planTitle="Root canal" currentDate={T}
      seq={2} sessionCount={5} onClose={onClose} onMoved={onMoved} {...props} />,
  );
  return { ...r, onClose, onMoved };
}
const moveBtn = () => screen.getByRole("button", { name: /Move session/ });
const preset = (name: string) => screen.getByRole("button", { name });
const dayInput = () => screen.getByPlaceholderText("Day");

describe("REG-FE-SHARED moving a session to another day", () => {
  beforeEach(() => {
    freezeToday(T);
    api.rescheduleSession.mockReset();
    api.rescheduleSession.mockResolvedValue({});
    Object.values(toast).forEach((f) => f.mockReset());
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-SHARED-001 names the visit, its course, and its current date in both calendars", () => {
    dialog();
    expect(screen.getByText("Reschedule visit 2")).toBeInTheDocument();
    expect(screen.getByText("Root canal")).toBeInTheDocument();
    expect(screen.getByText(`Session 2 of 5 · currently ${short(T)} (${formatEthiopian(T)} EC)`, { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/This changes the date only/)).toBeInTheDocument();
  });

  test("REG-FE-SHARED-002 the second line: free text wins, then 'Session N', then nothing", () => {
    const a = dialog({ detail: "Crown fitting" });
    expect(screen.getByText(/^Crown fitting · currently/)).toBeInTheDocument();
    a.unmount();
    const b = dialog({ sessionCount: undefined });
    expect(screen.getByText(/^Session 2 · currently/)).toBeInTheDocument();
    b.unmount();
    dialog({ seq: undefined, sessionCount: undefined });
    expect(screen.getByText("Reschedule visit")).toBeInTheDocument();
    expect(screen.getByText(/^currently/)).toBeInTheDocument();
  });

  test("REG-FE-SHARED-003 an overdue session restates how long ago it was missed", () => {
    const a = dialog({ currentDate: "2026-08-01", missed: true });
    expect(screen.getByText("· missed 11 days ago")).toBeInTheDocument();
    a.unmount();
    dialog({ currentDate: "2026-08-11", missed: true });
    expect(screen.getByText("· missed yesterday")).toBeInTheDocument();
  });

  test("REG-FE-SHARED-004 Move is disabled until the date actually changes", () => {
    dialog();
    expect(moveBtn()).toBeDisabled();
    expect(screen.queryByText(/New date:/)).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-005 'Next week' moves seven days on, confirms the new day, and sends only that date", async () => {
    const { user, onMoved, onClose } = dialog();
    await user.click(preset("Next week"));
    const to = "2026-08-19";
    expect(screen.getByText(`New date: ${long(to)} · ${formatEthiopian(to)} EC · in 7 days`)).toBeInTheDocument();
    await user.click(moveBtn());
    await waitFor(() => expect(api.rescheduleSession).toHaveBeenCalledWith("pat_1", "s2", to));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`Session 2 moved to ${short(to)}`));
    expect(onMoved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-SHARED-006 each quick offset counts from today, not from the session's current date", async () => {
    const { user } = dialog({ currentDate: "2026-07-01" });
    const cases: [string, string, string][] = [
      ["In 3 days", "2026-08-15", "in 3 days"],
      ["In 2 weeks", "2026-08-26", "in 14 days"],
      ["Next month", "2026-09-11", "in 30 days"],
      ["Today", T, "today"],
    ];
    for (const [label, iso, rel] of cases) {
      await user.click(preset(label));
      expect(screen.getByText(`New date: ${long(iso)} · ${formatEthiopian(iso)} EC · ${rel}`)).toBeInTheDocument();
    }
    await user.click(moveBtn());
    await waitFor(() => expect(api.rescheduleSession).toHaveBeenCalledWith("pat_1", "s2", T));
  });

  test("REG-FE-SHARED-007 a preset is reflected in the Ethiopian picker", async () => {
    const { user } = dialog();
    const before = (dayInput() as HTMLInputElement).value;
    await user.click(preset("In 3 days"));
    expect(Number((dayInput() as HTMLInputElement).value)).not.toBe(Number(before));
    expect(screen.getByText(`Gregorian: ${new Date("2026-08-15T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`)).toBeInTheDocument();
  });

  test("REG-FE-SHARED-008 typing an Ethiopian day picks that day; tomorrow reads as 'tomorrow'", async () => {
    const { user } = dialog();
    const day = Number((dayInput() as HTMLInputElement).value);
    fireEvent.change(dayInput(), { target: { value: String(day + 1) } });
    expect(screen.getByText(/· tomorrow$/)).toBeInTheDocument();
    await user.click(moveBtn());
    await waitFor(() => expect(api.rescheduleSession).toHaveBeenCalledWith("pat_1", "s2", "2026-08-13"));
  });

  test("REG-FE-SHARED-009 a half-typed Ethiopian date is not a choice: Move is disabled and nothing warns", () => {
    dialog();
    fireEvent.change(dayInput(), { target: { value: "" } });
    expect(moveBtn()).toBeDisabled();
    expect(screen.queryByText(/in the past/)).not.toBeInTheDocument();
    expect(screen.queryByText(/New date:/)).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-010 a past date warns but can still be saved (recording a visit that already happened)", async () => {
    const { user } = dialog();
    await user.click(screen.getByRole("button", { name: "Gregorian" }));
    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: "2026-08-01" } });
    expect(screen.getByText(/That date is in the past/)).toBeInTheDocument();
    expect(screen.queryByText(/New date:/)).not.toBeInTheDocument();
    expect(moveBtn()).toBeEnabled();
    await user.click(moveBtn());
    await waitFor(() => expect(api.rescheduleSession).toHaveBeenCalledWith("pat_1", "s2", "2026-08-01"));
  });

  test("REG-FE-SHARED-011 a clash on the chosen day lists what is already booked, and does not block", async () => {
    const clashes = vi.fn((iso: string) => (iso === "2026-08-19" ? [{ id: "x", label: "Filling · visit 1", done: true }] : []));
    const { user } = dialog({ clashes });
    expect(clashes).toHaveBeenCalledWith(T);
    await user.click(preset("Next week"));
    expect(clashes).toHaveBeenLastCalledWith("2026-08-19");
    expect(screen.getByText("There is already a session that day")).toBeInTheDocument();
    expect(screen.getByText("Filling · visit 1 (done)")).toBeInTheDocument();
    expect(screen.getByText(/allow enough chair time/)).toBeInTheDocument();
    expect(screen.queryByText(/New date:/)).not.toBeInTheDocument();
    expect(moveBtn()).toBeEnabled();
  });

  test("REG-FE-SHARED-012 several clashes are counted", async () => {
    const { user } = dialog({ clashes: () => [{ id: "a", label: "Scaling" }, { id: "b", label: "Crown" }] });
    await user.click(preset("In 3 days"));
    expect(screen.getByText("There are already 2 sessions that day")).toBeInTheDocument();
    expect(screen.getByText("Scaling")).toBeInTheDocument();
    expect(screen.getByText("Crown")).toBeInTheDocument();
  });

  test("REG-FE-SHARED-013 without a visit number the toast says 'Moved to …'", async () => {
    const { user } = dialog({ seq: undefined, sessionCount: undefined });
    await user.click(preset("Next week"));
    await user.click(moveBtn());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(`Moved to ${short("2026-08-19")}`));
  });

  test("REG-FE-SHARED-014 a refused move says why (or a fallback) and the dialog stays open", async () => {
    api.rescheduleSession.mockRejectedValueOnce(new AppError(409, "DONE", "That session is already done")).mockRejectedValueOnce(new Error("x"));
    const { user, onMoved, onClose } = dialog();
    await user.click(preset("Next week"));
    await user.click(moveBtn());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That session is already done"));
    await user.click(moveBtn());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not move this session"));
    expect(onMoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("REG-FE-SHARED-015 Move is disabled while the request is in flight", async () => {
    let resolve!: () => void;
    api.rescheduleSession.mockReturnValue(new Promise<void>((r) => { resolve = r; }));
    const { user } = dialog();
    await user.click(preset("Next week"));
    await user.click(moveBtn());
    await waitFor(() => expect(moveBtn()).toBeDisabled());
    fireEvent.click(moveBtn());
    expect(api.rescheduleSession).toHaveBeenCalledTimes(1);
    resolve();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  test("REG-FE-SHARED-016 Cancel and Esc close without moving", async () => {
    const { user, onClose } = dialog();
    await user.click(preset("Next week"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
    expect(api.rescheduleSession).not.toHaveBeenCalled();
  });
});
