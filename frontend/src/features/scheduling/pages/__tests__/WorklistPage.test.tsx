// The doctor's "My day" page (/worklist — hidden from the dental menu, still
// reachable by URL). What a clinic relies on: the doctor sees their waiting
// patients (and the unassigned pool they can pick up), in-progress encounters with
// why they are parked, upcoming appointments, and what they closed; opening a
// consult marks it in consult and goes to the encounter; picking a patient up
// assigns them to the doctor and opens the encounter; someone who may read users
// can look at another doctor's day, read-only.
import { screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/app/auth-context", async () => (await import("@/test/frontdesk")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));

import { WorklistPage } from "@/features/scheduling/pages/WorklistPage";
import type { WorklistEntry } from "@/features/scheduling/api";
import { currentLocation, renderUI } from "@/test/render";
import { fail, fake, resetToasts, setAuth, toasts, type FrontUser } from "@/test/frontdesk";

const DOC: FrontUser = { id: "usr_doc", full_name: "Dr Hana", roles: ["doctor"] };
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const wl = (id: string, over: Partial<WorklistEntry> = {}): WorklistEntry => ({
  id, patient_id: `p_${id}`, department_id: "dep_opd", state: "waiting", stage: "with_doctor", priority: 0,
  enqueued_at: minsAgo(9), patient_name: `Patient ${id}`, mrn: `MRN-${id}`, ...over,
});

function page() {
  return renderUI(
    <Routes>
      <Route path="/worklist" element={<WorklistPage />} />
      <Route path="/encounter/:id" element={<p>encounter page</p>} />
    </Routes>,
    { route: "/worklist" },
  );
}
const tab = (label: RegExp) => screen.getByRole("button", { name: label });

beforeEach(() => {
  fake.reset();
  resetToasts();
  setAuth({ perms: ["encounter.manage"], flags: [], user: DOC });
  fake.on("GET", "/worklist", []);
  fake.on("GET", "/worklist/unassigned", []);
  fake.on("GET", "/encounters/board", { active: [], done: [] });
  fake.on("GET", "/org/branches", [{ id: "br_main", name: "Main" }]);
  fake.on("GET", "/appointments", []);
  fake.on("GET", "/users", [
    { id: "usr_doc", full_name: "Dr Hana", status: "active" },
    { id: "usr_doc2", full_name: "Dr Yonas", status: "active" },
    { id: "usr_gone", full_name: "Dr Former", status: "disabled" },
  ]);
});

describe("REG-FE-MYDAY the doctor's My day page", () => {
  test("REG-FE-MYDAY-001 an empty day: every tab says it is empty; today's window; no doctor picker", async () => {
    const { user } = page();
    expect(await screen.findByText("No patients waiting.")).toBeInTheDocument();
    expect(screen.getByText("Your patients — waiting, in progress, scheduled and done.")).toBeInTheDocument();
    const q = fake.sent("GET", "/worklist")[0].query;
    expect(q.get("provider")).toBeNull();
    expect(new Date(q.get("to")!).getTime() - new Date(q.get("from")!).getTime()).toBe(86_400_000);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(fake.sent("GET", "/users")).toHaveLength(0);
    await user.click(tab(/In progress/));
    expect(screen.getByText("No in-progress encounters.")).toBeInTheDocument();
    await user.click(tab(/Appointments/));
    expect(await screen.findByText("No upcoming appointments.")).toBeInTheDocument();
    await user.click(tab(/Done/));
    expect(screen.getByText("Nothing closed in this range.")).toBeInTheDocument();
  });

  test("REG-FE-MYDAY-002 waiting patients: department and wait; Open consult starts the consult and opens it", async () => {
    fake.on("GET", "/worklist", [wl("a", { department_name: "OPD" }), wl("b", { state: "in_consult" })]);
    const { user } = page();
    expect(await screen.findByText("Patient a")).toBeInTheDocument();
    expect(screen.getByText("MRN-a · OPD · waiting 9m")).toBeInTheDocument();
    expect(screen.getByText("MRN-b · waiting 9m")).toBeInTheDocument();
    expect(screen.getByText("in consult")).toBeInTheDocument();
    expect(tab(/Waiting\s*2/)).toBeInTheDocument();
    const cardA = screen.getByText("Patient a").closest("div.rounded-lg") as HTMLElement;
    await user.click(within(cardA).getByRole("button", { name: /Open consult/ }));
    expect(fake.lastBody("POST", "/queue/a/transition")).toEqual({ state: "in_consult" });
    expect(currentLocation()).toBe("/encounter/a");
  });

  test("REG-FE-MYDAY-003 a patient already in consult is reopened without a second transition", async () => {
    fake.on("GET", "/worklist", [wl("b", { state: "in_consult" })]);
    const { user } = page();
    await user.click(await screen.findByRole("button", { name: /Open consult/ }));
    expect(fake.sent("POST", "/queue/:id/transition")).toHaveLength(0);
    expect(currentLocation()).toBe("/encounter/b");
  });

  test("REG-FE-MYDAY-004 a failed transition does not stop the doctor opening the consult", async () => {
    fake.on("GET", "/worklist", [wl("a")]);
    fake.on("POST", "/queue/a/transition", fail(409, "already moved"));
    const { user } = page();
    await user.click(await screen.findByRole("button", { name: /Open consult/ }));
    expect(currentLocation()).toBe("/encounter/a");
  });

  test("REG-FE-MYDAY-005 the unassigned pool: Pick up assigns to me and opens the encounter", async () => {
    fake.on("GET", "/worklist/unassigned", [wl("u", { department_name: "OPD" })]);
    const { user } = page();
    expect(await screen.findByText("Unassigned · available to pick up")).toBeInTheDocument();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(tab(/Waiting\s*1/)).toBeInTheDocument();
    expect(screen.queryByText("No patients waiting.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Pick up/ }));
    await waitFor(() => expect(currentLocation()).toBe("/encounter/u"));
    expect(fake.lastBody("POST", "/queue/u/assign")).toEqual({ provider_id: "usr_doc" });
    expect(toasts("success")).toEqual(["Patient picked up"]);
  });

  test("REG-FE-MYDAY-006 a pick-up someone else beat me to shows the reason and stays put", async () => {
    fake.on("GET", "/worklist/unassigned", [wl("u")]);
    fake.on("POST", "/queue/u/assign", fail(409, "Already picked up by Dr Yonas"));
    const { user } = page();
    await user.click(await screen.findByRole("button", { name: /Pick up/ }));
    await waitFor(() => expect(toasts("error")).toEqual(["Already picked up by Dr Yonas"]));
    expect(currentLocation()).toBe("/worklist");
  });

  test("REG-FE-MYDAY-007 with nobody signed in there is no one to pick up for", async () => {
    setAuth({ perms: ["encounter.manage"], flags: [], user: null });
    fake.on("GET", "/worklist/unassigned", [wl("u")]);
    page();
    await screen.findByText("Patient u");
    expect(screen.queryByRole("button", { name: /Pick up/ })).not.toBeInTheDocument();
  });

  test("REG-FE-MYDAY-008 in progress: why each encounter is parked; Resume only with a queue entry", async () => {
    fake.on("GET", "/encounters/board", {
      active: [
        { encounter_id: "e1", queue_entry_id: "q1", status: "open", started_at: "2026-10-03T07:30:00Z", patient_name: "Open One", mrn: "M1", pending_labs: 0 },
        { encounter_id: "e2", queue_entry_id: "q2", status: "awaiting_results", started_at: "2026-10-03T07:30:00Z", patient_name: "Lab Two", mrn: "M2", pending_labs: 2 },
        { encounter_id: "e3", queue_entry_id: null, status: "awaiting_results", started_at: "2026-10-03T07:30:00Z", patient_name: "Results Three", mrn: "M3", pending_labs: 0 },
      ],
      done: [],
    });
    const { user } = page();
    await user.click(await screen.findByRole("button", { name: /In progress\s*3/ }));
    expect(screen.getByText("In consultation")).toBeInTheDocument();
    expect(screen.getByText("Awaiting lab (2)")).toBeInTheDocument();
    expect(screen.getByText("Awaiting results")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Resume/ })).toHaveLength(2);
    expect(screen.getByText(/M1 · started/)).toBeInTheDocument();
    const lab = screen.getByText("Lab Two").closest("div.rounded-lg") as HTMLElement;
    await user.click(within(lab).getByRole("button", { name: /Resume/ }));
    expect(currentLocation()).toBe("/encounter/q2");
  });

  test("REG-FE-MYDAY-009 done: what was closed, with the time", async () => {
    fake.on("GET", "/encounters/board", {
      active: [],
      done: [
        { encounter_id: "d1", closed_at: "2026-10-03T08:15:00Z", started_at: "", patient_name: "Closed One", mrn: "M1" },
        { encounter_id: "d2", started_at: "", patient_name: "Closed Two", mrn: "M2" },
      ],
    });
    const { user } = page();
    await user.click(await screen.findByRole("button", { name: /Done\s*2/ }));
    expect(screen.getByText("Closed One")).toBeInTheDocument();
    expect(screen.getAllByText(/^Closed/).length).toBeGreaterThanOrEqual(2);
  });

  test("REG-FE-MYDAY-010 appointments: only open ones, soonest first, across the doctor's branches", async () => {
    fake.on("GET", "/org/branches", [{ id: "br_main", name: "Main" }, { id: "br_2", name: "Piassa" }]);
    fake.on("GET", "/appointments", (r: { query: URLSearchParams }) => r.query.get("branch") === "br_main"
      ? [
        { id: "a2", starts_at: "2026-10-05T09:00:00Z", status: "booked", patient_name: "Later", mrn: "M2", department_name: "OPD", reason: "Review" },
        { id: "a3", starts_at: "2026-10-04T09:00:00Z", status: "cancelled", patient_name: "Cancelled", mrn: "M3" },
      ]
      : [{ id: "a1", starts_at: "2026-10-04T09:00:00Z", status: "checked_in", patient_name: "Sooner", mrn: "M1" }]);
    const { user } = page();
    await screen.findByText("No patients waiting.");
    await user.click(tab(/Appointments/));
    expect(await screen.findByText("Sooner")).toBeInTheDocument();
    const names = [...document.querySelectorAll("p.font-medium.text-brand")].map((p) => p.textContent);
    expect(names).toEqual(["Sooner", "Later"]);
    expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
    expect(screen.getByText("M2 · OPD · Review")).toBeInTheDocument();
    expect(screen.getByText("checked in")).toBeInTheDocument();
    const calls = fake.sent("GET", "/appointments");
    expect(calls.map((c) => c.query.get("branch")).sort()).toEqual(["br_2", "br_main"]);
    expect(calls.every((c) => c.query.get("provider") === "usr_doc")).toBe(true);
  });

  test("REG-FE-MYDAY-011 one branch failing does not hide the other branch's appointments", async () => {
    fake.on("GET", "/org/branches", [{ id: "br_main", name: "Main" }, { id: "br_2", name: "Piassa" }]);
    fake.on("GET", "/appointments", (r: { query: URLSearchParams }) => {
      if (r.query.get("branch") === "br_2") return fail(403, "no access")();
      return [{ id: "a1", starts_at: "2026-10-04T09:00:00Z", status: "booked", patient_name: "Visible", mrn: "M1" }];
    });
    const { user } = page();
    await screen.findByText("No patients waiting.");
    await user.click(tab(/Appointments/));
    expect(await screen.findByText("Visible")).toBeInTheDocument();
  });

  test("REG-FE-MYDAY-012 no branches visible: points to the Appointments page", async () => {
    fake.on("GET", "/org/branches", []);
    const { user } = page();
    await screen.findByText("No patients waiting.");
    await user.click(tab(/Appointments/));
    expect(screen.getByRole("link", { name: "Appointments" })).toHaveAttribute("href", "/appointments");
  });

  test("REG-FE-MYDAY-013 a lead with user.read views another doctor's day read-only", async () => {
    setAuth({ perms: ["encounter.manage", "user.read"], flags: [], user: DOC });
    fake.on("GET", "/worklist", (r: { query: URLSearchParams }) => (r.query.get("provider") === "usr_doc2" ? [wl("y")] : [wl("mine")]));
    fake.on("GET", "/encounters/board", (r: { query: URLSearchParams }) => r.query.get("provider") === "usr_doc2"
      ? { active: [{ encounter_id: "e", queue_entry_id: "q", status: "open", started_at: "2026-10-03T07:30:00Z", patient_name: "Theirs", mrn: "M", pending_labs: 0 }], done: [] }
      : { active: [], done: [] });
    const { user } = page();
    expect(await screen.findByText("Patient mine")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("option", { name: "Dr Former" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "Dr Yonas" }));
    expect(await screen.findByText("Patient y")).toBeInTheDocument();
    expect(screen.getByText("The selected doctor's patients.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open consult/ })).not.toBeInTheDocument();
    await user.click(tab(/In progress/));
    expect(screen.getByText("Theirs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Resume/ })).not.toBeInTheDocument();
    // Choosing "My patients" again returns to my own day.
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "My patients" }));
    await user.click(tab(/Waiting/));
    expect(await screen.findByText("Patient mine")).toBeInTheDocument();
  });

  test("REG-FE-MYDAY-014 picking yourself in the list is still your own day", async () => {
    setAuth({ perms: ["encounter.manage", "user.read"], flags: [], user: DOC });
    fake.on("GET", "/worklist", [wl("a")]);
    const { user } = page();
    await screen.findByText("Patient a");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Dr Hana" }));
    await waitFor(() => expect(fake.sent("GET", "/worklist").at(-1)!.query.get("provider")).toBe("usr_doc"));
    expect(screen.getByRole("button", { name: /Open consult/ })).toBeInTheDocument();
  });
});
