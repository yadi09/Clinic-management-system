// The chair: the dentist's list of who is waiting, in the chair, unclaimed and seen.
// The chair list, the queue transitions and the provider assignment are mocked, so
// each test sets the day's rows and asserts what the dentist sees and what each
// button sends. "Today" is frozen so wait times and the date-range window are
// stable. Toasts are spied on through a mocked sonner; the Undo on the check-out
// toast is invoked from the captured toast options.
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// These render the whole dental page and type into it; under a full parallel run
// (with coverage) a test can take longer than the 5 s default.
vi.setConfig({ testTimeout: 20000 });

const api = vi.hoisted(() => ({ chairside: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));

const sched = vi.hoisted(() => ({ transitionQueue: vi.fn(), assignProvider: vi.fn() }));
vi.mock("@/features/scheduling/api", async (orig) => ({ ...(await orig<object>()), ...sched }));

const admin = vi.hoisted(() => ({ listUsers: vi.fn() }));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...admin }));

vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch), apiList: vi.fn(async () => ({ items: [], meta: {} })) };
});

const tst = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast: tst }));

const auth = vi.hoisted(() => ({ perms: new Set<string>(["user.read"]), user: { id: "u1", full_name: "Dr Me" } as { id: string; full_name: string } | null }));
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: () => true, user: auth.user, activeBranchId: null }),
}));

import { ChairsidePage } from "@/features/dental/ChairsidePage";
import type { ChairPatient } from "@/features/dental/api";
import { AppError } from "@/lib/api-client";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

const T = "2026-08-12";
const NOW = new Date(`${T}T09:00:00`).getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();

function C(id: string, over: Partial<ChairPatient> = {}): ChairPatient {
  return {
    queue_id: `q_${id}`, patient_id: `pat_${id}`, state: "waiting", priority: 0, enqueued_at: ago(10),
    provider_id: "u1", provider_name: "Dr Me", patient_name: `Patient ${id}`, mrn: `MRN-${id}`, age: 30, sex: "F",
    owed: "0", unbilled: "0", recorded_this_visit: 1, ...over,
  };
}

function page(rows: ChairPatient[] | Promise<never>) {
  if (rows instanceof Promise) api.chairside.mockReturnValue(rows);
  else api.chairside.mockResolvedValue(rows);
  return renderUI(<ChairsidePage />, { route: "/chairside" });
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const btn = (name: string | RegExp) => screen.getByRole("button", { name });
/** The card that carries this patient's name. */
const cardOf = (name: string) => screen.getByText(name).closest(".rounded-lg, .border-l-4") as HTMLElement;

describe("REG-FE-CHAIR the chairside page", () => {
  beforeEach(() => {
    freezeToday(T);
    Object.values(api).forEach((f) => f.mockReset());
    Object.values(sched).forEach((f) => f.mockReset());
    Object.values(tst).forEach((f) => f.mockReset());
    admin.listUsers.mockReset().mockResolvedValue([
      { id: "u1", full_name: "Dr Me", status: "active" },
      { id: "u2", full_name: "Dr Hana", status: "active" },
      { id: "u3", full_name: "Dr Gone", status: "disabled" },
    ]);
    auth.perms = new Set(["user.read"]);
    auth.user = { id: "u1", full_name: "Dr Me" };
    sched.transitionQueue.mockResolvedValue({});
    sched.assignProvider.mockResolvedValue({});
  });
  afterEach(() => vi.useRealTimers());

  test("REG-FE-CHAIR-001 loading: the header and the list both say Loading…", () => {
    page(new Promise<never>(() => {}));
    expect(screen.getByRole("heading", { name: "Chairside" })).toBeInTheDocument();
    expect(screen.getAllByText("Loading…")).toHaveLength(2);
  });

  test("REG-FE-CHAIR-002 a failed load is an error with Retry, never the empty state; Retry asks again", async () => {
    api.chairside.mockRejectedValueOnce(new Error("network")).mockResolvedValue([C("a")]);
    const { user } = renderUI(<ChairsidePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the chair list");
    expect(screen.queryByText(/Nobody waiting/)).not.toBeInTheDocument();
    await user.click(btn(/Retry/));
    expect(await screen.findByText("Patient a")).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-003 asks for my patients today: provider = me and today's window", async () => {
    page([]);
    await waitFor(() => expect(api.chairside).toHaveBeenCalled());
    const [prov, from, to] = api.chairside.mock.calls[0];
    expect(prov).toBe("u1");
    expect(new Date(from).getTime()).toBe(new Date(`${T}T00:00:00`).getTime());
    expect(new Date(to).getTime()).toBe(new Date("2026-08-13T00:00:00").getTime());
    expect(await screen.findByText("Patients reception has sent to your chair.")).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-004 every lens has its own empty sentence and note", async () => {
    const { user } = page([]);
    expect(await screen.findByText("Nobody waiting. Reception sends them here.")).toBeInTheDocument();
    expect(screen.getByText("Sent through by reception and waiting for you.")).toBeInTheDocument();
    expect(tab(/Waiting/)).toHaveAttribute("aria-selected", "true");
    await user.click(tab(/In the chair/));
    expect(screen.getByText("Nobody in the chair. Open a waiting patient's chart to start.")).toBeInTheDocument();
    expect(screen.getByText("Being treated now.")).toBeInTheDocument();
    await user.click(tab(/Unclaimed/));
    expect(screen.getByText("Everyone sent through has a dentist.")).toBeInTheDocument();
    expect(screen.getByText(/the ones most easily forgotten/)).toBeInTheDocument();
    await user.click(tab(/Seen/));
    expect(screen.getByText("Nobody has been checked out yet.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted; put anyone back/)).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-005 rows sort into the four lenses, and each tab shows its count", async () => {
    const { user } = page([
      C("w1"), C("w2", { state: "called" }), C("c1", { state: "in_consult", started_at: ago(5) }),
      C("u1", { provider_id: undefined }), C("u2", { provider_id: undefined, state: "called" }),
      C("s1", { state: "done" }), C("s2", { state: "done", provider_id: undefined }),
    ]);
    await screen.findByText("Patient w1");
    expect(tab(/In the chair/)).toHaveTextContent("In the chair1");
    expect(tab(/Waiting/)).toHaveTextContent("Waiting2");
    expect(tab(/Unclaimed/)).toHaveTextContent("Unclaimed2");
    expect(tab(/Seen/)).toHaveTextContent("Seen2");
    expect(screen.getByText("Patient w2")).toBeInTheDocument();
    expect(screen.queryByText("Patient c1")).not.toBeInTheDocument();
    await user.click(tab(/In the chair/));
    expect(screen.getByText("Patient c1")).toBeInTheDocument();
    await user.click(tab(/Unclaimed/));
    expect(screen.getByText("Patient u1")).toBeInTheDocument();
    expect(screen.getByText("Patient u2")).toBeInTheDocument();
    await user.click(tab(/Seen/));
    expect(screen.getByText("Patient s1")).toBeInTheDocument();
    expect(screen.getByText("Patient s2")).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-006 a waiting card: allergy in red, MRN · age · sex · department, wait, course, money", async () => {
    page([C("a", {
      allergies: "Penicillin, Latex", department_name: "Dental", plan_title: "Root canal", plan_done: 1, plan_total: 3,
      owed: "1500", unbilled: "2000.4", recorded_this_visit: 0,
    })]);
    await screen.findByText("Patient a");
    const card = cardOf("Patient a");
    expect(within(card).getByText(/Penicillin, Latex/).className).toMatch(/destructive/);
    expect(within(card).getByText("MRN-a · 30y F · Dental")).toBeInTheDocument();
    expect(within(card).getByText("waiting 10m")).toBeInTheDocument();
    expect(within(card).getByText("Root canal · 1 of 3 done")).toBeInTheDocument();
    expect(within(card).getByText("2,000 ETB unbilled")).toBeInTheDocument();
    expect(within(card).getByText("1,500 ETB at the cashier")).toBeInTheDocument();
    // On a waiting card only unbilled work is a warning: nobody expects a record
    // before treatment starts, and money owed is not a hard stop.
    expect(within(card).getByText("2,000 ETB of treatment has been given and never billed.")).toBeInTheDocument();
    expect(within(card).queryByText(/Nothing has been recorded/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/still owed/)).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Open chart/ })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Check out/ })).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-007 a bare card: no age, sex, department, allergy, course or money lines", async () => {
    page([C("a", { age: 0, sex: undefined, department_name: undefined })]);
    await screen.findByText("Patient a");
    const card = cardOf("Patient a");
    expect(within(card).getByText("MRN-a")).toBeInTheDocument();
    expect(within(card).queryByText(/ETB/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/done$/)).not.toBeInTheDocument();
    expect(card.querySelector(".bg-amber-50")).toBeNull();
  });

  test("REG-FE-CHAIR-008 waits read as minutes, hours and minutes, one day, or days", async () => {
    page([
      C("m", { enqueued_at: ago(0) }), C("h", { enqueued_at: ago(125) }),
      C("d1", { enqueued_at: ago(60 * 30) }), C("dn", { enqueued_at: ago(60 * 24 * 64 + 5) }),
      C("future", { enqueued_at: ago(-30) }),
    ]);
    await screen.findByText("Patient m");
    expect(within(cardOf("Patient m")).getByText("waiting 0m")).toBeInTheDocument();
    expect(within(cardOf("Patient h")).getByText("waiting 2h 5m")).toBeInTheDocument();
    expect(within(cardOf("Patient d1")).getByText("waiting 1 day")).toBeInTheDocument();
    expect(within(cardOf("Patient dn")).getByText("waiting 64 days")).toBeInTheDocument();
    expect(within(cardOf("Patient future")).getByText("waiting 0m")).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-009 in the chair: time since started, Continue, and the empty-record warning", async () => {
    const { user } = page([
      C("c", { state: "in_consult", started_at: ago(45), recorded_this_visit: 0 }),
      C("n", { state: "in_consult", started_at: undefined, enqueued_at: ago(20) }),
    ]);
    await user.click(await screen.findByRole("tab", { name: /In the chair/ }));
    const card = cardOf("Patient c");
    expect(within(card).getByText("in the chair 45m")).toBeInTheDocument();
    expect(within(card).getByText(/Nothing has been recorded at this visit/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Continue/ })).toBeInTheDocument();
    // Without a start time it falls back to the wait.
    expect(within(cardOf("Patient n")).getByText("waiting 20m")).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-010 Open chart marks a waiting patient in the chair, then opens their record", async () => {
    const { user } = page([C("a")]);
    await user.click(await screen.findByRole("button", { name: /Open chart/ }));
    await waitFor(() => expect(currentLocation()).toBe("/patients/pat_a"));
    expect(sched.transitionQueue).toHaveBeenCalledWith("q_a", "in_consult");
    expect(api.chairside.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("REG-FE-CHAIR-011 Continue on someone already in the chair opens the record without a transition", async () => {
    const { user } = page([C("a", { state: "in_consult", started_at: ago(5) })]);
    await user.click(await screen.findByRole("tab", { name: /In the chair/ }));
    await user.click(btn(/Continue/));
    await waitFor(() => expect(currentLocation()).toBe("/patients/pat_a"));
    expect(sched.transitionQueue).not.toHaveBeenCalled();
  });

  test("REG-FE-CHAIR-012 a failed mark-in-chair is said out loud, and the chart opens anyway", async () => {
    sched.transitionQueue.mockRejectedValueOnce(new AppError(409, "conflict", "Already with another dentist"));
    const { user, unmount } = page([C("a")]);
    await user.click(await screen.findByRole("button", { name: /Open chart/ }));
    await waitFor(() => expect(currentLocation()).toBe("/patients/pat_a"));
    expect(tst.error).toHaveBeenCalledWith("Already with another dentist");
    unmount();
    sched.transitionQueue.mockRejectedValueOnce(new Error("offline"));
    const second = page([C("b")]);
    await second.user.click(await screen.findByRole("button", { name: /Open chart/ }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not mark them in the chair — opening anyway"));
    expect(currentLocation()).toBe("/patients/pat_b");
  });

  test("REG-FE-CHAIR-013 check-out with nothing outstanding: says so, the button is plain Check out, Cancel closes", async () => {
    const { user } = page([C("a")]);
    await user.click(await screen.findByRole("button", { name: /Check out/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Check out Patient a?")).toBeInTheDocument();
    expect(within(dlg).getByText(/The visit is recorded and nothing is outstanding/)).toBeInTheDocument();
    expect(within(dlg).getByText(/put them back from/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Check out" })).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(sched.transitionQueue).not.toHaveBeenCalled();
  });

  test("REG-FE-CHAIR-014 check-out with an empty record, unbilled work and money owed names all three: End the visit anyway", async () => {
    const { user } = page([C("a", { recorded_this_visit: 0, unbilled: "800", owed: "1200" })]);
    await user.click(await screen.findByRole("button", { name: /Check out/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Nothing has been recorded at this visit — no treatment, no examination.")).toBeInTheDocument();
    expect(within(dlg).getByText("800 ETB of treatment has been given and never billed.")).toBeInTheDocument();
    expect(within(dlg).getByText("1,200 ETB is still owed and waiting at the cashier.")).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "End the visit anyway" })).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-015 money owed alone is mentioned but is not a hard stop: the button stays Check out", async () => {
    const { user } = page([C("a", { owed: "500" })]);
    await user.click(await screen.findByRole("button", { name: /Check out/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("500 ETB is still owed and waiting at the cashier.")).toBeInTheDocument();
    expect(within(dlg).queryByText(/nothing is outstanding/)).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Check out" })).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-016 confirming check-out sends done, closes, refreshes and offers Undo that puts them back", async () => {
    const { user } = page([C("a")]);
    await user.click(await screen.findByRole("button", { name: /Check out/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(sched.transitionQueue).toHaveBeenCalledWith("q_a", "done"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(tst.success).toHaveBeenCalled());
    const [msg, opts] = tst.success.mock.calls[0];
    expect(msg).toBe("Patient a checked out");
    expect(opts.action.label).toBe("Undo");
    const before = api.chairside.mock.calls.length;
    expect(before).toBeGreaterThanOrEqual(2); // refreshed after the check-out
    await act(async () => { opts.action.onClick(); });
    expect(sched.transitionQueue).toHaveBeenLastCalledWith("q_a", "waiting");
    await waitFor(() => expect(api.chairside.mock.calls.length).toBeGreaterThan(before));
  });

  test("REG-FE-CHAIR-017 a failed Undo says it could not undo", async () => {
    const { user } = page([C("a")]);
    await user.click(await screen.findByRole("button", { name: /Check out/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(tst.success).toHaveBeenCalled());
    sched.transitionQueue.mockRejectedValueOnce(new Error("offline"));
    await act(async () => { tst.success.mock.calls[0][1].action.onClick(); });
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not undo the check-out"));
  });

  test("REG-FE-CHAIR-018 while checking out the confirm button is disabled; a failure keeps the dialog and says why", async () => {
    let reject!: (e: unknown) => void;
    sched.transitionQueue.mockReturnValueOnce(new Promise((_r, j) => { reject = j; }));
    const { user } = page([C("a")]);
    await user.click(await screen.findByRole("button", { name: /Check out/ }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(within(dlg).getByRole("button", { name: /Check out/ })).toBeDisabled());
    await act(async () => reject(new AppError(409, "conflict", "Visit already closed")));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Visit already closed"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    sched.transitionQueue.mockRejectedValueOnce(new Error("offline"));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Check out" }));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not check out"));
    expect(sched.transitionQueue).toHaveBeenCalledTimes(2);
  });

  test("REG-FE-CHAIR-019 unclaimed: dashed card, Unassigned, no chart or check-out, Pick up claims for me", async () => {
    const { user } = page([C("a", { provider_id: undefined, recorded_this_visit: 0, unbilled: "100" })]);
    await user.click(await screen.findByRole("tab", { name: /Unclaimed/ }));
    const card = cardOf("Patient a");
    expect(card.className).toMatch(/border-dashed/);
    expect(within(card).getByText("Unassigned")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Open chart|Check out/ })).not.toBeInTheDocument();
    // The check-out warnings are not shown on a card nobody has claimed.
    expect(within(card).queryByText(/never billed/)).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: /Pick up/ }));
    await waitFor(() => expect(sched.assignProvider).toHaveBeenCalledWith("q_a", "u1"));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Patient a picked up"));
  });

  test("REG-FE-CHAIR-020 Pick up is disabled while pending, and a failure says why", async () => {
    let reject!: (e: unknown) => void;
    sched.assignProvider.mockReturnValueOnce(new Promise((_r, j) => { reject = j; }));
    const { user } = page([C("a", { provider_id: undefined })]);
    await user.click(await screen.findByRole("tab", { name: /Unclaimed/ }));
    await user.click(btn(/Pick up/));
    await waitFor(() => expect(btn(/Pick up/)).toBeDisabled());
    await act(async () => reject(new AppError(409, "taken", "Already picked up by Dr Hana")));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Already picked up by Dr Hana"));
    sched.assignProvider.mockRejectedValueOnce(new Error("offline"));
    await user.click(btn(/Pick up/));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not pick up the patient"));
  });

  test("REG-FE-CHAIR-021 seen: nothing-recorded and unbilled tags, the check-out time and dentist; Open chart opens", async () => {
    const ended = ago(30);
    const { user } = page([C("a", { state: "done", ended_at: ended, recorded_this_visit: 0, unbilled: "300" }),
      C("b", { state: "done", ended_at: undefined, provider_name: undefined })]);
    await user.click(await screen.findByRole("tab", { name: /Seen/ }));
    const row = cardOf("Patient a");
    expect(within(row).getByText("nothing recorded")).toBeInTheDocument();
    expect(within(row).getByText("300 ETB unbilled")).toBeInTheDocument();
    const t = new Date(ended).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(within(row).getByText(`MRN-a · seen ${t} · Dr Me`)).toBeInTheDocument();
    const t2 = new Date(ago(10)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(within(cardOf("Patient b")).getByText(`MRN-b · seen ${t2}`)).toBeInTheDocument();
    expect(within(cardOf("Patient b")).queryByText("nothing recorded")).not.toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: /Open chart/ }));
    expect(currentLocation()).toBe("/patients/pat_a");
    expect(sched.transitionQueue).not.toHaveBeenCalled();
  });

  test("REG-FE-CHAIR-022 Put back sends waiting and says they are back; a failure says why", async () => {
    const { user } = page([C("a", { state: "done" })]);
    await user.click(await screen.findByRole("tab", { name: /Seen/ }));
    await user.click(btn(/Put back/));
    await waitFor(() => expect(sched.transitionQueue).toHaveBeenCalledWith("q_a", "waiting"));
    await waitFor(() => expect(tst.success).toHaveBeenCalledWith("Patient a is back at the chair"));
    sched.transitionQueue.mockRejectedValueOnce(new AppError(409, "x", "Day closed"));
    await user.click(btn(/Put back/));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Day closed"));
    sched.transitionQueue.mockRejectedValueOnce(new Error("offline"));
    await user.click(btn(/Put back/));
    await waitFor(() => expect(tst.error).toHaveBeenCalledWith("Could not put them back"));
  });

  test("REG-FE-CHAIR-023 Put back is disabled on that row only while it is pending", async () => {
    sched.transitionQueue.mockReturnValueOnce(new Promise(() => {}));
    const { user } = page([C("a", { state: "done" }), C("b", { state: "done" })]);
    await user.click(await screen.findByRole("tab", { name: /Seen/ }));
    await user.click(within(cardOf("Patient a")).getByRole("button", { name: /Put back/ }));
    await waitFor(() => expect(within(cardOf("Patient a")).getByRole("button", { name: /Put back/ })).toBeDisabled());
    expect(within(cardOf("Patient b")).getByRole("button", { name: /Put back/ })).toBeEnabled();
  });

  test("REG-FE-CHAIR-024 the date range: 3 days, 7 days and All each ask for their own window", async () => {
    const { user } = page([]);
    await waitFor(() => expect(api.chairside).toHaveBeenCalledTimes(1));
    const day = (iso: string) => new Date(`${iso}T00:00:00`).getTime();
    await user.click(screen.getByRole("tab", { name: "3 days" }));
    await waitFor(() => expect(api.chairside).toHaveBeenCalledTimes(2));
    expect(new Date(api.chairside.mock.calls[1][1]).getTime()).toBe(day("2026-08-10"));
    expect(new Date(api.chairside.mock.calls[1][2]).getTime()).toBe(day("2026-08-13"));
    await user.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(api.chairside).toHaveBeenCalledTimes(3));
    expect(new Date(api.chairside.mock.calls[2][1]).getTime()).toBe(day("2026-08-06"));
    expect(new Date(api.chairside.mock.calls[2][2]).getTime()).toBe(day("2026-08-13"));
    await user.click(screen.getByRole("tab", { name: "All" }));
    await waitFor(() => expect(api.chairside).toHaveBeenCalledTimes(4));
    expect(api.chairside.mock.calls[3]).toEqual(["u1", "2000-01-01T00:00:00.000Z", undefined]);
  });

  test("REG-FE-CHAIR-025 the provider picker lists active dentists; choosing one shows and claims for them", async () => {
    const { user } = page([C("a", { provider_id: undefined })]);
    await screen.findByRole("tab", { name: /Unclaimed/ });
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("My patients");
    await user.click(trigger);
    expect(await screen.findByRole("option", { name: "Dr Hana" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Dr Gone" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Dr Hana" }));
    await waitFor(() => expect(api.chairside).toHaveBeenLastCalledWith("u2", expect.any(String), expect.any(String)));
    await user.click(tab(/Unclaimed/));
    await user.click(await screen.findByRole("button", { name: /Pick up/ }));
    await waitFor(() => expect(sched.assignProvider).toHaveBeenCalledWith("q_a", "u2"));
    // Back to my own list.
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "My patients" }));
    await waitFor(() => expect(api.chairside).toHaveBeenLastCalledWith("u1", expect.any(String), expect.any(String)));
  });

  test("REG-FE-CHAIR-026 without user.read there is no provider picker and the staff list is never fetched", async () => {
    auth.perms = new Set();
    page([]);
    await waitFor(() => expect(api.chairside).toHaveBeenCalled());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(admin.listUsers).not.toHaveBeenCalled();
  });

  test("REG-FE-CHAIR-027 with no signed-in user and nobody picked, an unclaimed card offers no Pick up", async () => {
    auth.user = null;
    auth.perms = new Set();
    const { user } = page([C("a", { provider_id: undefined })]);
    await user.click(await screen.findByRole("tab", { name: /Unclaimed/ }));
    expect(screen.getByText("Patient a")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Pick up/ })).not.toBeInTheDocument();
    expect(api.chairside.mock.calls[0][0]).toBeUndefined();
  });

  test("REG-FE-CHAIR-028 more than fifteen: paged as Showing x–y of n, with Previous and Next", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => C(`w${String(i + 1).padStart(2, "0")}`));
    const { user } = page(rows);
    await screen.findByText("Patient w01");
    expect(screen.getByText("Showing 1–15 of 20")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(btn(/Previous/)).toBeDisabled();
    expect(screen.queryByText("Patient w16")).not.toBeInTheDocument();
    await user.click(btn(/Next/));
    expect(screen.getByText("Showing 16–20 of 20")).toBeInTheDocument();
    expect(screen.getByText("Patient w16")).toBeInTheDocument();
    expect(screen.queryByText("Patient w01")).not.toBeInTheDocument();
    expect(btn(/Next/)).toBeDisabled();
    await user.click(btn(/Previous/));
    expect(screen.getByText("Showing 1–15 of 20")).toBeInTheDocument();
    // Changing the lens goes back to the first page.
    await user.click(btn(/Next/));
    await user.click(tab(/Seen/));
    await user.click(tab(/Waiting/));
    expect(screen.getByText("Showing 1–15 of 20")).toBeInTheDocument();
  });

  test("REG-FE-CHAIR-029 fifteen or fewer: no pager", async () => {
    page(Array.from({ length: 15 }, (_, i) => C(`w${i}`)));
    await screen.findByText("Patient w0");
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
  });

  test("REG-FE-CHAIR-030 when a refresh shrinks the list, a page past the end moves back to one with rows", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => C(`w${String(i + 1).padStart(2, "0")}`));
    const { user } = page(rows);
    await screen.findByText("Patient w01");
    await user.click(btn(/Next/));
    expect(screen.getByText("Patient w16")).toBeInTheDocument();
    // Checking out w16 refreshes the list, which now holds only five.
    api.chairside.mockResolvedValue(rows.slice(0, 5));
    await user.click(within(cardOf("Patient w16")).getByRole("button", { name: /Check out/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Check out" }));
    expect(await screen.findByText("Patient w01")).toBeInTheDocument();
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
    expect(screen.getByText("Patient w05")).toBeInTheDocument();
  });
});
