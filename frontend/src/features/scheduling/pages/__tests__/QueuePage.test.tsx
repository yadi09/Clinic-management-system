// The live department queue board (/queue — hidden from the dental menu, still
// reachable by URL). What a clinic relies on: it picks the first department by
// itself, asks for today's window, sorts each patient into Waiting / In consult /
// In lab / Done by state, shows how long each has waited, refreshes when the live
// stream says the queue changed, remembers board vs list, and filters the list by
// status. It never moves anyone — it is view only.
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));

import { QueuePage } from "@/features/scheduling/pages/QueuePage";
import type { QueueEntry } from "@/features/scheduling/api";
import { fail, fake } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

class FakeES {
  static all: FakeES[] = [];
  url: string;
  closed = false;
  listeners: Record<string, (() => void)[]> = {};
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  addEventListener(t: string, fn: () => void) { (this.listeners[t] ??= []).push(fn); }
  close() { this.closed = true; }
  emit(t: string) { (this.listeners[t] ?? []).forEach((f) => f()); }
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const entry = (id: string, state: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
  id, patient_id: `p_${id}`, state, stage: "with_doctor", priority: 0, enqueued_at: minsAgo(12),
  patient_name: `Patient ${id}`, mrn: `MRN-${id}`, has_vitals: true, in_lab: false, ...over,
});

const DEPTS = [{ id: "dep_opd", name: "OPD" }, { id: "dep_dent", name: "Dental" }];

beforeEach(() => {
  fake.reset();
  FakeES.all = [];
  vi.stubGlobal("EventSource", FakeES);
  try { localStorage.removeItem("clinicos_queue_view"); } catch { /* ignore */ }
  fake.on("GET", "/org/departments", DEPTS);
  fake.on("GET", "/queue", []);
});
afterEach(() => vi.unstubAllGlobals());

const queueCalls = () => fake.sent("GET", "/queue");
const lane = (name: string) => screen.getByRole("heading", { name }).closest("div.rounded-lg") as HTMLElement;

describe("REG-FE-QUEUE the live queue board", () => {
  test("REG-FE-QUEUE-001 no departments: tells the clinic to create one, asks for no queue", async () => {
    fake.on("GET", "/org/departments", []);
    renderUI(<QueuePage />);
    expect(await screen.findByText("Create a department in Settings to use the queue.")).toBeInTheDocument();
    expect(queueCalls()).toHaveLength(0);
    expect(FakeES.all).toHaveLength(0);
  });

  test("REG-FE-QUEUE-002 picks the first department and asks for today's window; empty says so", async () => {
    renderUI(<QueuePage />);
    expect(await screen.findByText("No patients in this range.")).toBeInTheDocument();
    const q = queueCalls()[0].query;
    expect(q.get("department")).toBe("dep_opd");
    expect(q.get("stage")).toBeNull();
    const from = new Date(q.get("from")!), to = new Date(q.get("to")!);
    expect(to.getTime() - from.getTime()).toBe(86_400_000);
    expect(from.getHours()).toBe(0);
    expect(FakeES.all[0].url).toContain("/queue/stream?department=dep_opd");
  });

  test("REG-FE-QUEUE-003 the board sorts patients into lanes by state, with waits and doctors", async () => {
    fake.on("GET", "/queue", [
      entry("w1", "waiting", { provider_name: "Dr Hana", enqueued_at: minsAgo(25) }),
      entry("c1", "called"),
      entry("ic", "in_consult", { provider_name: "Dr Yonas" }),
      entry("lab", "in_consult", { in_lab: true, provider_name: "Dr Yonas" }),
      entry("d1", "done"),
      entry("ns", "no_show"),
    ]);
    renderUI(<QueuePage />);
    await screen.findByText("Patient w1");
    const waiting = lane("Waiting");
    expect(within(waiting).getByText("Patient w1")).toBeInTheDocument();
    expect(within(waiting).getByText("Patient c1")).toBeInTheDocument();
    expect(within(waiting).getByText("25m")).toBeInTheDocument();
    expect(within(waiting).getByText("Dr Hana")).toBeInTheDocument();
    expect(within(waiting).getByText("2")).toBeInTheDocument();
    expect(within(lane("In consult")).getByText("Patient ic")).toBeInTheDocument();
    expect(within(lane("In consult")).getByText("Dr Yonas")).toBeInTheDocument();
    const inLab = lane("In lab");
    expect(within(inLab).getByText("Patient lab")).toBeInTheDocument();
    expect(within(inLab).getByText("Awaiting lab results")).toBeInTheDocument();
    expect(within(inLab).queryByText("Dr Yonas")).not.toBeInTheDocument();
    const done = lane("Done");
    expect(within(done).getByText("Patient d1")).toBeInTheDocument();
    expect(within(done).getByText("Patient ns")).toBeInTheDocument();
    expect(within(done).queryByText(/\d+m$/)).not.toBeInTheDocument();
    // It is view only: no action buttons on the cards.
    expect(screen.queryByRole("button", { name: /call|start|done|move/i })).not.toBeInTheDocument();
  });

  test("REG-FE-QUEUE-004 an empty lane says Empty", async () => {
    fake.on("GET", "/queue", [entry("w1", "waiting")]);
    renderUI(<QueuePage />);
    await screen.findByText("Patient w1");
    expect(within(lane("Done")).getByText("Empty")).toBeInTheDocument();
    expect(within(lane("In lab")).getByText("Empty")).toBeInTheDocument();
  });

  test("REG-FE-QUEUE-005 the live stream says the queue changed: the board refetches", async () => {
    renderUI(<QueuePage />);
    await screen.findByText("No patients in this range.");
    const before = queueCalls().length;
    fake.on("GET", "/queue", [entry("new", "waiting")]);
    FakeES.all[0].emit("queue");
    expect(await screen.findByText("Patient new")).toBeInTheDocument();
    expect(queueCalls().length).toBeGreaterThan(before);
  });

  test("REG-FE-QUEUE-006 switching department reconnects the stream and asks for that department", async () => {
    const { user } = renderUI(<QueuePage />);
    await screen.findByText("No patients in this range.");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Dental" }));
    await waitFor(() => expect(queueCalls().at(-1)!.query.get("department")).toBe("dep_dent"));
    expect(FakeES.all[0].closed).toBe(true);
    expect(FakeES.all.at(-1)!.url).toContain("department=dep_dent");
  });

  test("REG-FE-QUEUE-007 a different date range asks for that window", async () => {
    const { user } = renderUI(<QueuePage />);
    await screen.findByText("No patients in this range.");
    await user.click(screen.getByRole("button", { name: "Yesterday" }));
    await waitFor(() => {
      const q = queueCalls().at(-1)!.query;
      expect(new Date(q.get("to")!).getHours()).toBe(0);
      expect(new Date(q.get("to")!).getDate()).toBe(new Date().getDate());
    });
  });

  test("REG-FE-QUEUE-008 the list view: status badges, doctor, wait; chips filter by status; choice remembered", async () => {
    fake.on("GET", "/queue", [
      entry("w1", "waiting", { enqueued_at: minsAgo(5) }),
      entry("lab", "in_consult", { in_lab: true, provider_name: "Dr Yonas" }),
      entry("ns", "no_show"),
      entry("d1", "done"),
    ]);
    const first = renderUI(<QueuePage />);
    await screen.findByText("Patient w1");
    await first.user.click(screen.getByRole("button", { name: /List/ }));
    const table = screen.getByRole("table");
    const rowOf = (n: string) => within(table).getByText(n).closest("tr") as HTMLElement;
    expect(within(rowOf("Patient w1")).getByText("Waiting")).toBeInTheDocument();
    expect(within(rowOf("Patient w1")).getByText("5m")).toBeInTheDocument();
    expect(within(rowOf("Patient w1")).getAllByText("—")).toHaveLength(1);
    expect(within(rowOf("Patient lab")).getByText("In lab")).toBeInTheDocument();
    expect(within(rowOf("Patient lab")).getByText("Dr Yonas")).toBeInTheDocument();
    expect(within(rowOf("Patient ns")).getByText("No-show")).toBeInTheDocument();
    expect(within(rowOf("Patient d1")).getByText("Done")).toBeInTheDocument();
    expect(within(rowOf("Patient d1")).getAllByText("—")).toHaveLength(2);

    await first.user.click(screen.getByRole("button", { name: /^Done\s*2$/ }));
    expect(within(table).queryByText("Patient w1")).not.toBeInTheDocument();
    expect(within(table).getByText("Patient d1")).toBeInTheDocument();
    await first.user.click(screen.getByRole("button", { name: /^In consult\s*0$/ }));
    expect(within(table).getByText("No patients in this status.")).toBeInTheDocument();
    await first.user.click(screen.getByRole("button", { name: /^All\s*4$/ }));
    expect(within(table).getByText("Patient w1")).toBeInTheDocument();

    expect(localStorage.getItem("clinicos_queue_view")).toBe("list");
    first.unmount();
    const second = renderUI(<QueuePage />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    await second.user.click(screen.getByRole("button", { name: /Board/ }));
    expect(localStorage.getItem("clinicos_queue_view")).toBe("board");
  });

  // NEW-QUEUEUI-1: a queue that fails to load renders "No patients in this range." —
  // the desk reads an outage as an empty waiting room. It should say it could not load.
  test.fails("REG-FE-QUEUE-009 a queue that fails to load says so, not 'No patients' (NEW-QUEUEUI-1)", async () => {
    fake.on("GET", "/queue", fail(500, "Database unavailable"));
    renderUI(<QueuePage />);
    await waitFor(() => expect(queueCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("No patients in this range.")).not.toBeInTheDocument();
    expect(screen.getByText(/could not|couldn't|failed|unavailable/i)).toBeInTheDocument();
  });
});
