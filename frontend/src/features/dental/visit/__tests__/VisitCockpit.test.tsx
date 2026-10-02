// The visit card at the top of a dental patient's page. Each test builds the
// patient's treatments with the fixtures, resolves the focus exactly as the page
// does (resolveFocus), renders the real card and reads it the way a dentist would:
// the chip, the sentence, the buttons. "Today" is frozen so the words are stable.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  updateSession: vi.fn(), rescheduleSession: vi.fn(), collectSession: vi.fn(), setPayLater: vi.fn(),
  addSession: vi.fn(), cancelCourse: vi.fn(), finishCourse: vi.fn(),
}));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch), apiList: vi.fn(async () => ({ items: [], meta: {} })) };
});

vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { VisitCockpit } from "@/features/dental/visit/VisitCockpit";
import { resolveFocus } from "@/features/dental/visit/useFocusVisit";
import type { Plan } from "@/features/dental/api";
import type { Allergy } from "@/features/patients/api";
import { freezeToday, renderUI } from "@/test/render";
import { P, S } from "./fixtures";

const T = "2026-08-12";
const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function card(plans: Plan[], opts: {
  chosen?: string; editable?: boolean; canReschedule?: boolean; canCollect?: boolean; allergies?: Allergy[];
} = {}) {
  const onPick = vi.fn(), onNewPlan = vi.fn(), onChanged = vi.fn();
  const r = renderUI(
    <VisitCockpit patientId="pat_1" resolved={resolveFocus(plans, T, opts.chosen)} plans={plans} teeth={{}}
      editable={opts.editable ?? true} canCollect={opts.canCollect ?? true} canReschedule={opts.canReschedule ?? true}
      imageLimit={-1} allergies={opts.allergies} onNewPlan={onNewPlan} onPick={onPick} onChanged={onChanged} />,
  );
  return { ...r, onPick, onNewPlan, onChanged };
}

const heading = () => screen.getByRole("heading", { level: 3, name: /^(Next: visit|Visit) \d/ });
/** The state chip sits right above the sentence. */
const chip = () => heading().previousElementSibling as HTMLElement;

describe("REG-FE-COCKPIT the visit card", () => {
  beforeEach(() => {
    freezeToday(T);
    sessionStorage.clear();
    Object.values(api).forEach((f) => f.mockReset());
    api.updateSession.mockResolvedValue({});
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-COCKPIT-001 no treatment: says so and offers Start a treatment only to an editor", async () => {
    const { user, onNewPlan, unmount } = card([]);
    expect(screen.getByText("No treatment in progress")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /start a treatment/i }));
    expect(onNewPlan).toHaveBeenCalledTimes(1);
    unmount();
    card([], { editable: false });
    expect(screen.getByText("No treatment in progress")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start a treatment/i })).not.toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-002 booked today: Today chip, visit N of M, Start visit N, the fee asked first", () => {
    card([P("p1", "Root canal", [
      S("s1", "2026-08-01", 1, "done", { procedure: "Pulpotomy", tooth: "UR5" }),
      S("s2", T, 2), S("s3", "2026-09-12", 3),
    ])]);
    expect(heading()).toHaveTextContent("Visit 2 of 3");
    expect(chip()).toHaveTextContent(/^Today$/);
    expect(screen.getByText(/Booked for/)).toHaveTextContent(/today,/);
    expect(screen.getByRole("button", { name: "Start visit 2" })).toBeEnabled();
    expect(screen.getByText(/Takes the 2,000 ETB fee first/)).toBeInTheDocument();
    // What happened last time is the question the dentist sits down with.
    expect(screen.getByText(`Last time: visit 1 on ${short("2026-08-01")}`)).toBeInTheDocument();
    expect(screen.getByText("Pulpotomy on UR5")).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-003 missed: names the missed visit, Rebook visit N, and the other missed one", () => {
    card([P("p1", "Root canal", [S("s1", "2026-08-01", 1), S("s2", "2026-08-05", 2), S("s3", "2026-09-01", 3)])]);
    expect(heading()).toHaveTextContent("Next: visit 1 of 3");
    expect(chip()).toHaveTextContent("2 visits missed");
    expect(screen.getByText(/didn't happen/)).toHaveTextContent("11 days ago");
    expect(screen.getByText(new RegExp(`Visit 2 on ${short("2026-08-05")} was missed too\\.`))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Rebook visit 1/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record visit 1" })).toBeEnabled();
  });

  test("REG-FE-COCKPIT-004 three missed: the sentence lists the other two together", () => {
    card([P("p1", "RCT", [S("s1", "2026-07-01", 1), S("s2", "2026-07-08", 2), S("s3", "2026-07-15", 3), S("s4", "2026-09-01", 4)])]);
    expect(screen.getByText("3 visits missed")).toBeInTheDocument();
    expect(screen.getByText(/Visits 2 and 3 were missed too\./)).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-005 without the reschedule permission there is no Rebook button", () => {
    card([P("p1", "RCT", [S("s1", "2026-08-01", 1), S("s2", "2026-09-01", 2)])], { canReschedule: false });
    expect(screen.queryByRole("button", { name: /Rebook/ })).not.toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-006 Rebook opens the reschedule dialog marked missed", async () => {
    const { user } = card([P("p1", "RCT", [S("s1", "2026-08-01", 1), S("s2", "2026-09-01", 2)])]);
    await user.click(screen.getByRole("button", { name: /Rebook visit 1/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("RCT")).toBeInTheDocument();
    expect(within(dlg).getByText(/missed 11 days ago/)).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-007 next and later: in N days, Record early, and a chosen later visit can go back", async () => {
    const plans = [P("p1", "RCT", [S("s1", "2026-08-20", 1), S("s2", "2026-09-20", 2)])];
    const first = card(plans);
    expect(chip()).toHaveTextContent("Next visit");
    expect(heading()).toHaveTextContent("Visit 1 of 2 · in 8 days");
    expect(screen.getByRole("button", { name: "Record visit 1 early" })).toBeInTheDocument();
    expect(screen.getByText(/Only if the patient came in before their booked day/)).toBeInTheDocument();
    first.unmount();

    const { user, onPick } = card(plans, { chosen: "s2" });
    expect(chip()).toHaveTextContent("Later visit");
    await user.click(screen.getByRole("button", { name: "Back to the current visit" }));
    expect(onPick).toHaveBeenCalledWith("s1");
  });

  test("REG-FE-COCKPIT-008 recorded: Visit N of M is done, what was done, and the next visit", () => {
    card([P("p1", "RCT", [
      S("s1", "2026-08-10", 1, "done", { procedure: "Pulpotomy", tooth: "UR5", notes: "Calm pulp", payment: "paid" }),
      S("s2", "2026-09-10", 2),
    ])], { chosen: "s1" });
    expect(heading()).toHaveTextContent("Visit 1 of 2 is done");
    expect(screen.getByText(/Done on/)).toHaveTextContent(`Next: visit 2 on ${short("2026-09-10")}.`);
    expect(screen.getByText("Pulpotomy · UR5")).toBeInTheDocument();
    expect(screen.getByText("Calm pulp")).toBeInTheDocument();
    // A paid visit collapses its money to one strip.
    expect(screen.getByText("Paid", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit visit 1/ })).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-009 recorded but unpaid: the payment step stays open with Send to cashier", () => {
    card([P("p1", "RCT", [S("s1", "2026-08-10", 1, "done", { procedure: "Scaling" }), S("s2", "2026-09-10", 2)])], { chosen: "s1" });
    expect(screen.getByRole("button", { name: /Send to cashier/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Treat now, pay later/ })).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-010 two treatments are tabs; picking the other opens its next step", async () => {
    const { user, onPick } = card([
      P("p1", "Root canal", [S("a1", T, 1)], "active", { start_date: "2026-01-01" }),
      P("p2", "Scaling", [S("b1", "2026-08-01", 1, "done"), S("b2", "2026-08-30", 2)], "active", { start_date: "2026-02-01" }),
    ]);
    const tabs = within(screen.getByRole("tablist", { name: "Treatments in progress" })).getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("2 treatments in progress", { selector: "p.max-sm\\:hidden" })).toBeInTheDocument();
    await user.click(tabs[1]);
    expect(onPick).toHaveBeenCalledWith("b2");
  });

  test("REG-FE-COCKPIT-011 a tab whose treatment has a missed visit says so to a screen reader", () => {
    card([
      P("p1", "Root canal", [S("a1", T, 1)], "active", { start_date: "2026-01-01" }),
      P("p2", "Scaling", [S("b1", "2026-08-01", 1)], "active", { start_date: "2026-02-01" }),
    ]);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs[1]).toHaveTextContent("(has a missed visit)");
    expect(tabs[0]).not.toHaveTextContent("(has a missed visit)");
  });

  test("REG-FE-COCKPIT-012 allergies are read out inside the card, joined in words", () => {
    card([P("p1", "RCT", [S("s1", T, 1)])], {
      allergies: [{ id: "a1", substance: "Penicillin" }, { id: "a2", substance: "Latex" }] as Allergy[],
    });
    expect(screen.getByRole("note")).toHaveTextContent("Allergic to Penicillin and Latex. Check before you treat.");
  });

  test("REG-FE-COCKPIT-013 no allergies, no allergy line", () => {
    card([P("p1", "RCT", [S("s1", T, 1)])]);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-014 Change date: Today and the booked day, and a future day disables Record", async () => {
    const { user } = card([P("p1", "RCT", [S("s1", "2026-08-01", 1), S("s2", "2026-09-01", 2)])]);
    expect(screen.getByText(/Saved as/)).toHaveTextContent(`Saved as today, ${short(T)}.`);
    await user.click(screen.getByRole("button", { name: "Change date" }));
    expect(screen.getByText("Which day did this visit happen?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Its booked day, ${short("2026-08-01")}` }));
    expect(screen.getByText(/Saved as/)).toHaveTextContent(`Saved as ${short("2026-08-01")}.`);
    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText(/Saved as/)).toHaveTextContent("Saved as today");

    await user.click(screen.getByRole("button", { name: "Gregorian" }));
    fireEvent.change(document.getElementById("record-date")!, { target: { value: "2026-08-20" } });
    expect(await screen.findByText("A visit can't be recorded on a day that hasn't come yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record visit 1" })).toBeDisabled();
  });

  test("REG-FE-COCKPIT-015 a missed visit recorded from the card is saved as today, in the one request", async () => {
    const { user, onChanged } = card([P("p1", "RCT", [S("s1", "2026-08-01", 1, "planned", { pay_later: true }), S("s2", "2026-09-01", 2)])]);
    await user.click(screen.getByRole("button", { name: "Record visit 1" }));
    await user.type(screen.getByPlaceholderText(/Crown cemented/), "Canal shaped");
    await user.click(screen.getByRole("button", { name: /Save & mark done/ }));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(1));
    expect(api.updateSession.mock.calls[0][1]).toBe("s1");
    expect(api.updateSession.mock.calls[0][2]).toMatchObject({ status: "done", notes: "Canal shaped", scheduled_date: T });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test("REG-FE-COCKPIT-016 an unpaid visit started today asks the fee before the notes", async () => {
    const { user } = card([P("p1", "RCT", [S("s1", T, 1), S("s2", "2026-09-01", 2)])]);
    await user.click(screen.getByRole("button", { name: "Start visit 1" }));
    expect(screen.getByText("Recording visit 1")).toBeInTheDocument();
    expect(screen.getByText("Then the treatment notes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save & mark done/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send to cashier/ })).toBeInTheDocument();
    // The visit list is hidden while recording, so a click cannot retarget the save.
    expect(screen.queryByRole("list", { name: "Visits in this treatment" })).not.toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-017 every visit is a step with its word, date and money, and opens on click", async () => {
    const { user, onPick } = card([P("p1", "RCT", [
      S("s1", "2026-08-01", 1, "done", { payment: "paid" }), S("s2", T, 2), S("s3", "2026-09-12", 3, "planned", { payment: "billed" }),
    ])]);
    const list = screen.getAllByRole("list", { name: "Visits in this treatment" })[0];
    const steps = within(list).getAllByRole("button");
    expect(steps.map((b) => b.getAttribute("aria-label"))).toEqual([
      `Visit 1, done, ${short("2026-08-01")}, paid`,
      `Visit 2, today, ${short(T)}, not paid`,
      `Visit 3, next, ${short("2026-09-12")}, at cashier`,
    ]);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    await user.click(steps[2]);
    expect(onPick).toHaveBeenCalledWith("s3");
  });

  test("REG-FE-COCKPIT-018 facts: treatment progress and money are separate lines", () => {
    card([P("p1", "RCT", [S("s1", "2026-08-01", 1, "done", { payment: "paid" }), S("s2", T, 2), S("s3", "2026-09-12", 3)],
      "active", { money: { planned: "6000", collected: "2000", at_cashier: "1000" } as Plan["money"] })]);
    expect(screen.getByText("1 of 3 visits done")).toBeInTheDocument();
    expect(screen.getByText("2,000 ETB paid")).toBeInTheDocument();
    expect(screen.getByText(/of 6,000 ETB/)).toBeInTheDocument();
    expect(screen.getByText("3,000 ETB left to pay")).toBeInTheDocument();
    expect(screen.getByText(/1,000 ETB at the cashier/)).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-019 facts: paid-ahead visits are named; a fully paid treatment says so", () => {
    card([P("p1", "RCT", [S("s1", T, 1), S("s2", "2026-09-01", 2, "planned", { payment: "paid" }), S("s3", "2026-09-12", 3, "planned", { payment: "paid" })],
      "active", { money: { planned: "6000", collected: "6000", at_cashier: "0" } as Plan["money"] })]);
    expect(screen.getByText("fully paid")).toBeInTheDocument();
    expect(screen.getByText("Visits 2 and 3 are paid but not done yet.")).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-020 facts: a treatment with no charge says so instead of 0 ETB", () => {
    card([P("p1", "Check-up", [S("s1", T, 1, "planned", { amount_due: "0" })])]);
    expect(screen.getByText("No charge for this treatment")).toBeInTheDocument();
  });

  test("REG-FE-COCKPIT-021 read-only viewer: no record button, no More menu, no New treatment", () => {
    card([P("p1", "RCT", [S("s1", T, 1)])], { editable: false, canReschedule: false });
    expect(screen.queryByRole("button", { name: /Start visit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New treatment/ })).not.toBeInTheDocument();
  });

  const more = async (user: ReturnType<typeof card>["user"], item: string) => {
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: item }));
    return screen.findByRole("dialog");
  };

  test("REG-FE-COCKPIT-022 Finish lists every visit it will cancel, promised ones included, and keeps the down payment owed", async () => {
    const plan = P("p1", "RCT", [
      S("s1", "2026-08-01", 1, "done", { payment: "paid" }), S("s2", T, 2, "planned", { pay_later: true }),
      S("s3", "2026-09-12", 3, "planned", { payment: "billed" }), S("s4", "2026-10-12", 4),
    ], "active", { deposit: { id: "dep", amount_due: "1000", payment: "unpaid", scheduled_date: "2026-08-01" } as Plan["deposit"] });
    api.finishCourse.mockResolvedValue({ sessions_cancelled: 2 });
    const { user, onChanged } = card([plan]);
    const dlg = await more(user, "Finish this treatment");
    const rows = within(within(dlg).getByRole("list")).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/^Visit 2 · .* · promised pay-later2,000 ETB$/),
      expect.stringMatching(/^Visit 4 · .*2,000 ETB$/),
    ]);
    expect(within(dlg).getByText(/The down payment of/)).toHaveTextContent("1,000 ETB is not paid yet and stays owed");
    await user.click(within(dlg).getByRole("button", { name: "Finish treatment" }));
    await waitFor(() => expect(api.finishCourse).toHaveBeenCalledWith("pat_1", "p1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test("REG-FE-COCKPIT-023 Cancel this treatment needs a reason, which is sent with it", async () => {
    api.cancelCourse.mockResolvedValue({});
    const { user } = card([P("p1", "RCT", [S("s1", T, 1), S("s2", "2026-09-12", 2)])]);
    const dlg = await more(user, "Cancel this treatment…");
    expect(within(dlg).getByText(/Its 2 booked visits will be cancelled/)).toBeInTheDocument();
    const ok = within(dlg).getByRole("button", { name: "Cancel the treatment" });
    expect(ok).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/Why\?/), "Wrong patient");
    await user.click(ok);
    await waitFor(() => expect(api.cancelCourse).toHaveBeenCalledWith("pat_1", "p1", "Wrong patient"));
  });

  test("REG-FE-COCKPIT-024 Add a visit suggests one interval after the last visit, at the usual fee", async () => {
    api.addSession.mockResolvedValue({});
    const { user } = card([P("p1", "RCT", [S("s1", T, 1), S("s2", "2026-09-12", 2), S("s3", "2026-10-12", 3, "planned", { amount_due: "1500" })])]);
    const dlg = await more(user, "Add a visit to this treatment");
    expect(within(dlg).getByLabelText("Fee (ETB)")).toHaveValue(2000);
    await user.click(within(dlg).getByRole("button", { name: "Add visit" }));
    await waitFor(() => expect(api.addSession).toHaveBeenCalledWith("pat_1", "p1", { scheduled_date: "2026-11-12", amount_due: "2000" }));
  });
});
