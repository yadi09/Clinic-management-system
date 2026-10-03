// The shared pieces every admin screen is built from: the plan fence, the upsell,
// the load-failure line, confirmation, dual dates, the tablist, and the small ui kit.
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
const admin = vi.hoisted(() => ({ planUsage: vi.fn() }));
vi.mock("@/features/admin/api", () => admin);

import { PlanGate } from "@/components/PlanGate";
import { PlanUpsell } from "@/components/PlanUpsell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { LoadError } from "@/components/LoadError";
import { useConfirmDialog, type ConfirmRequest } from "@/components/ConfirmDialog";
import { DualDate, dayDiff, relativeDay } from "@/components/DualDate";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { Segmented } from "@/components/ui/segmented";
import { DateRangeFilter, windowFor } from "@/components/ui/date-range-filter";
import { Stepper } from "@/components/ui/stepper";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger, DialogClose } from "@/components/ui/dialog";
import { AppError } from "@/lib/api-client";
import { deferred, setAuth } from "@/test/admin";
import { currentLocation, freezeToday, renderUI } from "@/test/render";

beforeEach(() => setAuth());

describe("REG-FE-PLAN plan gate and upsell", () => {
  test("REG-FE-PLAN-001 entitled: the page renders", () => {
    setAuth({ flags: ["finance_advanced"] });
    renderUI(<PlanGate feature="finance_advanced"><p>Finance page</p></PlanGate>);
    expect(screen.getByText("Finance page")).toBeInTheDocument();
    expect(admin.planUsage).not.toHaveBeenCalled();
  });

  test("REG-FE-PLAN-002 not entitled, not the owner: back to the dashboard with no price list", () => {
    setAuth({ flags: [], perms: ["billing.manage"] });
    renderUI(<Routes><Route path="/" element={<p>Home</p>} /><Route path="/finance" element={<PlanGate feature="finance_advanced"><p>Finance</p></PlanGate>} /></Routes>, { route: "/finance" });
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(currentLocation()).toBe("/");
  });

  test("REG-FE-PLAN-003 not entitled, the owner: what it is, the current plan, and the plans that have it", async () => {
    setAuth({ flags: [] });
    admin.planUsage.mockResolvedValue({ plan_name: "Chair", features: [
      { code: "finance_advanced", name: "Finance", detail: "Ageing, cash and services.", category: "money", included: false, on_plans: ["Practice", "Group", "Custom"] },
    ] });
    renderUI(<PlanGate feature="finance_advanced"><p>Finance page</p></PlanGate>);
    expect(await screen.findByRole("heading", { name: "Finance" })).toBeInTheDocument();
    expect(screen.getByText("Not on this plan")).toBeInTheDocument();
    expect(screen.getByText("Ageing, cash and services.")).toBeInTheDocument();
    expect(screen.getByText("Chair")).toBeInTheDocument();
    expect(screen.getByText("Practice, Group and Custom")).toBeInTheDocument();
    expect(screen.queryByText("Finance page")).not.toBeInTheDocument();
  });

  test("REG-FE-PLAN-004 one plan is named alone; none says ask us; unknown feature has a fallback name", async () => {
    admin.planUsage.mockResolvedValue({ plan_name: "", features: [{ code: "messaging", name: "Messages", category: "x", included: false, on_plans: ["Practice"] }] });
    const r = renderUI(<PlanUpsell feature="messaging" />);
    expect(await screen.findByText("Practice")).toBeInTheDocument();
    expect(screen.queryByText(/This clinic is on/)).not.toBeInTheDocument();
    r.unmount();
    renderUI(<PlanUpsell feature="dhis2" />);
    expect(await screen.findByRole("heading", { name: "This feature" })).toBeInTheDocument();
    expect(screen.getByText(/Ask us about adding it/)).toBeInTheDocument();
  });

  test("REG-FE-PLAN-005 while the plan loads, a placeholder — not a wrong answer", () => {
    admin.planUsage.mockReturnValue(new Promise(() => {}));
    const { container } = renderUI(<PlanUpsell feature="messaging" />);
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    expect(screen.queryByText("Not on this plan")).not.toBeInTheDocument();
  });
});

describe("REG-FE-GUARD protected route", () => {
  const app = (route: string) => renderUI(
    <Routes>
      <Route path="/login" element={<p>Sign in</p>} />
      <Route element={<ProtectedRoute />}><Route path="/settings" element={<p>Settings</p>} /></Route>
    </Routes>, { route });

  test("REG-FE-GUARD-001 signed in: through; loading: wait; signed out: to sign-in", () => {
    const a = app("/settings");
    expect(screen.getByText("Settings")).toBeInTheDocument();
    a.unmount();
    setAuth({ status: "loading" });
    const b = app("/settings");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    b.unmount();
    setAuth({ status: "unauthenticated" });
    app("/settings");
    expect(screen.getByText("Sign in")).toBeInTheDocument();
    expect(currentLocation()).toBe("/login");
  });
});

describe("REG-FE-LOADERR load failure", () => {
  test("REG-FE-LOADERR-001 a failed load says so, says it is not 'none', and retries", async () => {
    const retry = vi.fn();
    render(<LoadError what="the payment methods" onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load the payment methods. This is not the same as there being none");
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(retry).toHaveBeenCalledOnce();
  });

  // FE-10. LoadError has one sentence for every failure: "check the connection".
  // A 403 (the role lacks the permission) is not a connection problem, and telling
  // a receptionist to retry a refusal sends them round in circles instead of to
  // the owner. The component is not even given the error to tell them apart.
  test.fails("REG-FE-LOADERR-002 KNOWN BUG FE-10 a 403 is shown as no access, not as a network error", () => {
    const err = new AppError(403, "FORBIDDEN", "You do not have permission");
    const Props = LoadError as unknown as (p: { what: string; onRetry: () => void; error: unknown }) => JSX.Element;
    render(<Props what="the staff list" onRetry={() => {}} error={err} />);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/check the connection/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/permission|access/i);
  });
});

describe("REG-FE-CONFIRM confirm dialog", () => {
  function Harness({ req, onOk }: { req: ConfirmRequest; onOk: (r: string) => void | Promise<unknown> }) {
    const { ask, dialog } = useConfirmDialog();
    return <><button onClick={() => ask(req, onOk)}>open</button>{dialog}</>;
  }

  test("REG-FE-CONFIRM-001 names the act, states the consequence, cancels without acting", async () => {
    const ok = vi.fn();
    const user = userEvent.setup();
    render(<Harness req={{ title: "Remove CBE?", description: "It leaves the picker.", confirmLabel: "Remove", destructive: true }} onOk={ok} />);
    await user.click(screen.getByText("open"));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByRole("heading", { name: "Remove CBE?" })).toHaveClass("text-destructive");
    expect(within(dlg).getByText("It leaves the picker.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(ok).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  // NEW-CONFIRM-1. When the confirmed action rejects, confirm() re-throws from a
  // `void confirm()` click handler: the dialog correctly stays open, but the error
  // becomes an unhandled promise rejection (console noise in production, a hard
  // failure under Vitest). Not encoded as a test — any test of it fails the run.

  test("REG-FE-CONFIRM-002 a required reason blocks until given, is trimmed, and Enter confirms", async () => {
    const ok = vi.fn();
    const user = userEvent.setup();
    render(<Harness req={{ title: "Void?", reason: { label: "Why?", required: true, placeholder: "reason" } }} onOk={ok} />);
    await user.click(screen.getByText("open"));
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    const box = screen.getByPlaceholderText("reason");
    await user.type(box, "   {Enter}");
    expect(ok).not.toHaveBeenCalled();
    await user.type(box, " typo {Enter}");
    expect(ok).toHaveBeenCalledWith("typo");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-CONFIRM-003 a slow confirm shows pending and cannot be dismissed until it settles", async () => {
    const d = deferred();
    const user = userEvent.setup();
    const ok = vi.fn(() => d.promise);
    render(<Harness req={{ title: "Send?", reason: { label: "Note", multiline: true }, cancelLabel: "Back" }} onOk={ok} />);
    await user.click(screen.getByText("open"));
    await user.type(screen.getByRole("textbox"), "hi");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("button", { name: /Confirm/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => { d.resolve(undefined); await d.promise; });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(ok).toHaveBeenCalledWith("hi");
  });
});

describe("REG-FE-DUALDATE dates in both calendars", () => {
  beforeEach(() => freezeToday("2026-10-03", 10));
  afterEach(() => vi.useRealTimers());

  test("REG-FE-DUALDATE-001 Gregorian · Ethiopian, with the relative chip when asked", () => {
    render(<DualDate iso="2026-10-17" relative />);
    expect(screen.getByText(/· 7 Tikimt 2019/)).toBeInTheDocument();
    expect(screen.getByText("in 14 days")).toBeInTheDocument();
  });

  test("REG-FE-DUALDATE-002 relative words, and today is emphasised", () => {
    expect(relativeDay("2026-10-03")).toBe("today");
    expect(relativeDay("2026-10-04")).toBe("tomorrow");
    expect(relativeDay("2026-10-02")).toBe("yesterday");
    expect(relativeDay("2026-09-28")).toBe("5 days ago");
    expect(dayDiff("2026-10-10")).toBe(7);
    render(<DualDate iso="2026-10-03" long relative />);
    expect(screen.getByText("today")).toHaveClass("font-medium");
  });

  test("REG-FE-DUALDATE-003 blank renders nothing; a malformed date renders as itself", () => {
    const { container } = render(<DualDate iso="" />);
    expect(container).toBeEmptyDOMElement();
    render(<DualDate iso="not-a-date" />);
    expect(screen.getByText(/not-a-date|Invalid Date/)).toBeInTheDocument();
  });
});

describe("REG-FE-ETHINPUT Ethiopian date entry", () => {
  beforeEach(() => freezeToday("2026-10-03", 10));
  afterEach(() => vi.useRealTimers());

  function Harness({ initial = "" }: { initial?: string }) {
    const [v, setV] = useState(initial);
    return <><EthiopianDateInput value={v} onChange={setV} id="dob" /><output data-testid="v">{v}</output></>;
  }

  test("REG-FE-ETHINPUT-001 an existing value shows in Ethiopian with the Gregorian and the age", () => {
    render(<Harness initial="1990-09-11" />);
    expect(screen.getByPlaceholderText("Year")).toHaveValue(1983);
    expect(screen.getByPlaceholderText("Day")).toHaveValue(1);
    expect(screen.getByText(/Gregorian: 11 September 1990|Gregorian: September 11, 1990/)).toBeInTheDocument();
    expect(screen.getByText("· Age 36")).toBeInTheDocument();
  });

  test("REG-FE-ETHINPUT-002 typing a complete, valid date stores the Gregorian; an impossible one stores nothing", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2000-09-11" />);
    expect(screen.getByTestId("v")).toHaveTextContent("2000-09-11");
    await user.clear(screen.getByPlaceholderText("Day"));
    await user.type(screen.getByPlaceholderText("Day"), "31");
    expect(screen.getByTestId("v")).toHaveTextContent(/^$/);
    expect(screen.getByText("Enter the Ethiopian birthdate (ዓ.ም).")).toBeInTheDocument();
    await user.clear(screen.getByPlaceholderText("Day"));
    await user.type(screen.getByPlaceholderText("Day"), "2");
    expect(screen.getByTestId("v")).toHaveTextContent("2000-09-12");
  });

  test("REG-FE-ETHINPUT-003 Gregorian mode stores what is typed and re-syncs when switching back", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Gregorian" }));
    expect(screen.getByText("Enter the Gregorian date.")).toBeInTheDocument();
    fireEvent.change(document.querySelector("input[type=date]")!, { target: { value: "2020-01-07" } });
    expect(screen.getByTestId("v")).toHaveTextContent("2020-01-07");
    expect(screen.getByText(/Ethiopian: Tahsas 28, 2012 EC/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ethiopian" }));
    expect(screen.getByPlaceholderText("Year")).toHaveValue(2012);
  });

  test("REG-FE-ETHINPUT-004 choosing Pagumē caps the day at 5 or 6", async () => {
    const user = userEvent.setup();
    render(<Harness initial="2023-09-06" />);
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "Pagumē" }));
    expect(screen.getByPlaceholderText("Day")).toHaveAttribute("max", "6");
  });

  test("REG-FE-ETHINPUT-005 the age line can be switched off", () => {
    render(<EthiopianDateInput value="1990-09-11" onChange={() => {}} showAge={false} />);
    expect(screen.queryByText(/Age/)).not.toBeInTheDocument();
  });
});

describe("REG-FE-SEG segmented control", () => {
  function Harness({ onChange }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState("b");
    return (
      <Segmented ariaLabel="View" value={v} size="sm"
        onChange={(x) => { setV(x); onChange?.(x); }}
        options={[{ value: "a", label: "A" }, { value: "b", label: "B", badge: 3 }, { value: "x", label: "X", disabled: true }, { value: "c", label: "C" }]} />
    );
  }
  const tab = (n: string) => screen.getByRole("tab", { name: new RegExp(`^${n}`) });

  test("REG-FE-SEG-001 a real tablist: one selected, roving tabindex, a dimmed badge", () => {
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "View" })).toBeInTheDocument();
    expect(tab("B")).toHaveAttribute("aria-selected", "true");
    expect(tab("B")).toHaveAttribute("tabindex", "0");
    expect(tab("A")).toHaveAttribute("tabindex", "-1");
    expect(tab("B")).toHaveTextContent("B3");
    expect(tab("X")).toBeDisabled();
  });

  test("REG-FE-SEG-002 arrows move and select, skipping disabled, wrapping; Home/End jump; focus follows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    tab("B").focus();
    await user.keyboard("{ArrowRight}");
    expect(tab("C")).toHaveAttribute("aria-selected", "true");
    expect(tab("C")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(tab("A")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowLeft}");
    expect(tab("C")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{Home}");
    expect(tab("A")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{End}");
    expect(tab("C")).toHaveAttribute("aria-selected", "true");
    await user.keyboard("a");
    expect(tab("C")).toHaveAttribute("aria-selected", "true");
    await user.click(tab("A"));
    expect(tab("A")).toHaveAttribute("aria-selected", "true");
  });

  test("REG-FE-SEG-003 no selection: keys do nothing", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Segmented ariaLabel="P" value="" onChange={onChange} options={[{ value: "a", label: "A" }]} />);
    screen.getByRole("tab").focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("REG-FE-SEG-004 on a scrolling strip the selected segment is scrolled into view", () => {
    const spies = [
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(600),
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(200),
      vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "tab" ? (this.textContent === "C" ? 450 : 0) : 0;
      }),
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(100),
    ];
    function H() {
      const [v, setV] = useState("a");
      return <><Segmented ariaLabel="S" value={v} onChange={setV} options={["a", "b", "C"].map((x) => ({ value: x, label: x }))} /><button onClick={() => setV("C")}>go</button></>;
    }
    render(<H />);
    const strip = screen.getByRole("tablist");
    expect(strip.scrollLeft).toBe(0);
    fireEvent.click(screen.getByText("go"));
    expect(strip.scrollLeft).toBe(400); // 450 - (200 - 100) / 2
    spies.forEach((s) => s.mockRestore());
  });
});

describe("REG-FE-RANGE date range filter", () => {
  beforeEach(() => freezeToday("2026-10-03", 10));
  afterEach(() => vi.useRealTimers());
  const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

  test("REG-FE-RANGE-001 presets are local-day windows; All has no upper bound", () => {
    expect(windowFor("today")).toEqual({ from: local(2026, 10, 3), to: local(2026, 10, 4) });
    expect(windowFor("yesterday")).toEqual({ from: local(2026, 10, 2), to: local(2026, 10, 3) });
    expect(windowFor("3d")).toEqual({ from: local(2026, 10, 1), to: local(2026, 10, 4) });
    expect(windowFor("all")).toEqual({ from: "2000-01-01T00:00:00.000Z" });
    expect(windowFor("custom", "2026-09-01", "2026-09-30")).toEqual({ from: local(2026, 9, 1), to: local(2026, 10, 1) });
    expect(windowFor("custom")).toEqual(windowFor("today"));
  });

  test("REG-FE-RANGE-002 clicking presets and filling a custom range reports each window", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<DateRangeFilter onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Last 3 days" }));
    expect(onChange).toHaveBeenLastCalledWith(windowFor("3d"));
    await user.click(screen.getByRole("button", { name: "Custom" }));
    const [from, to] = container.querySelectorAll("input[type=date]");
    fireEvent.change(from, { target: { value: "2026-09-01" } });
    fireEvent.change(to, { target: { value: "2026-09-02" } });
    expect(onChange).toHaveBeenLastCalledWith({ from: local(2026, 9, 1), to: local(2026, 9, 3) });
    expect(screen.getByRole("button", { name: "Custom" })).toHaveClass("bg-primary");
  });
});

describe("REG-FE-UI small ui kit", () => {
  test("REG-FE-UI-001 stepper marks done, active and upcoming steps", () => {
    render(<Stepper steps={["Details", "Card", "Pay"]} current={1} />);
    expect(screen.getByText("Card")).toHaveClass("text-brand");
    expect(screen.getByText("Pay")).toHaveClass("text-muted-foreground");
    expect(screen.queryByText("1")).not.toBeInTheDocument(); // done step shows a tick
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  test("REG-FE-UI-002 table parts, alert, separator render their content", () => {
    render(
      <>
        <Table><TableHeader><TableRow><TableHead>H</TableHead></TableRow></TableHeader>
          <TableBody><TableRow><TableCell>C</TableCell></TableRow></TableBody></Table>
        <Alert variant="destructive"><AlertTitle>T</AlertTitle><AlertDescription>D</AlertDescription></Alert>
        <Separator orientation="vertical" />
      </>,
    );
    expect(screen.getByRole("table")).toHaveTextContent("HC");
    expect(screen.getByRole("alert")).toHaveTextContent("TD");
  });

  test("REG-FE-UI-003 tooltip shows its content on focus", async () => {
    render(<TooltipProvider delayDuration={0}><Tooltip><TooltipTrigger>i</TooltipTrigger><TooltipContent>More</TooltipContent></Tooltip></TooltipProvider>);
    act(() => screen.getByText("i").focus());
    expect((await screen.findAllByText("More")).length).toBeGreaterThan(0);
  });

  test("REG-FE-UI-004 a dialog is a bottom sheet with a grab handle, or full screen when asked; X closes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Dialog><DialogTrigger>open</DialogTrigger><DialogContent><DialogTitle>T</DialogTitle><DialogDescription>D</DialogDescription><DialogClose>done</DialogClose></DialogContent></Dialog>);
    await user.click(screen.getByText("open"));
    let dlg = screen.getByRole("dialog");
    expect(dlg).toHaveClass("max-h-[85dvh]");
    expect(dlg.querySelector("[aria-hidden].rounded-full")).not.toBeNull();
    await user.click(within(dlg).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<Dialog open><DialogContent fullOnMobile><DialogTitle>T</DialogTitle></DialogContent></Dialog>);
    dlg = screen.getByRole("dialog");
    expect(dlg).toHaveClass("h-[100dvh]");
    expect(dlg.querySelector("[aria-hidden].rounded-full")).toBeNull();
  });
});
