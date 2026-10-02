// The tooth chart. Two layers: the chart itself (read-only until the clinic's
// conditions have loaded, a tap reports the tooth), and the patient page's save
// around it (a tap is saved as just that tooth's change, Undo is saved like any
// other edit, and a failed save puts the chart back to what the server holds).
import { act, screen, waitFor, within } from "@testing-library/react";
import { Toaster } from "sonner";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ listToothStatuses: vi.fn(), saveChart: vi.fn(), dentalSummary: vi.fn() }));
vi.mock("@/features/dental/api", async (orig) => ({ ...(await orig<object>()), ...api }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch), apiList: vi.fn(async () => ({ items: [], meta: {} })) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: () => true, flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { ToothChart } from "@/features/dental/ToothChart";
import { DentalWorkspace } from "@/features/dental/DentalWorkspace";
import type { Summary, ToothStatusDef } from "@/features/dental/api";
import { renderUI } from "@/test/render";

const STATUSES: ToothStatusDef[] = [
  { id: "1", code: "healthy", label: "Healthy", color: "#10b981", sort_order: 1, is_active: true },
  { id: "2", code: "decayed", label: "Decayed", color: "#ef4444", sort_order: 2, is_active: true },
  { id: "3", code: "filled", label: "Filled", color: "#3b82f6", sort_order: 3, is_active: true },
];

const tooth = (code: string) => screen.getByRole("button", { name: new RegExp(`^${code}( —|$)`) });

describe("REG-FE-CHART the tooth chart", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    sessionStorage.clear();
  });

  test("REG-FE-CHART-001 read-only while the conditions load: says so, teeth cannot be tapped", async () => {
    api.listToothStatuses.mockReturnValue(new Promise(() => {}));
    renderUI(<ToothChart teeth={{}} editable onToggle={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the tooth conditions…");
    expect(tooth("UR1")).toBeDisabled();
  });

  test("REG-FE-CHART-002 the conditions failed to load: read-only, with Retry that asks again", async () => {
    api.listToothStatuses.mockRejectedValueOnce(new Error("down")).mockResolvedValue(STATUSES);
    const { user } = renderUI(<ToothChart teeth={{}} editable onToggle={vi.fn()} />);
    expect(await screen.findByText(/did not load — the chart is read-only/)).toBeInTheDocument();
    expect(tooth("LL8")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(tooth("LL8")).toBeEnabled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("REG-FE-CHART-003 loaded: 32 teeth, each saying its condition, and a tap reports the tooth", async () => {
    api.listToothStatuses.mockResolvedValue(STATUSES);
    const onToggle = vi.fn();
    const { user } = renderUI(<ToothChart teeth={{ UR6: "decayed", LL3: "retired_mark" }} editable onToggle={onToggle} />);
    await waitFor(() => expect(tooth("UR1")).toBeEnabled());
    expect(screen.getAllByRole("button", { name: /^[UL][RL]\d/ })).toHaveLength(32);
    expect(tooth("UR6")).toHaveAccessibleName("UR6 — Decayed");
    // A mark the clinic no longer lists is still shown, never read as healthy.
    expect(tooth("LL3")).toHaveAccessibleName("LL3 — retired mark");
    await user.click(tooth("UL4"));
    expect(onToggle).toHaveBeenCalledWith("UL4");
    // The legend is the clinic's own list.
    for (const s of STATUSES) expect(screen.getByText(s.label)).toBeInTheDocument();
  });

  test("REG-FE-CHART-004 a viewer without edit rights never gets a tappable chart", async () => {
    api.listToothStatuses.mockResolvedValue(STATUSES);
    renderUI(<ToothChart teeth={{}} editable={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(api.listToothStatuses).toHaveBeenCalled());
    expect(tooth("UR1")).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The save, on the patient page.

const summary = (teeth: Record<string, string>): Summary => ({
  chart: { teeth } as Summary["chart"],
  plans: [],
  balance: { owed: "0", paid: "0", balance: "0", due: "0", at_cashier: "0", waived: "0", overdue: false } as unknown as Summary["balance"],
  image_limit: -1,
});

async function openChart(teeth: Record<string, string>) {
  api.listToothStatuses.mockResolvedValue(STATUSES);
  api.dentalSummary.mockResolvedValue(summary(teeth));
  const r = renderUI(<><DentalWorkspace patientId="pat_1" /><Toaster /></>, { route: "/patients/pat_1" });
  await r.user.click(await screen.findByRole("button", { name: /Tooth chart/ }));
  await waitFor(() => expect(tooth("UR1")).toBeEnabled());
  return r;
}

describe("REG-FE-CHART saving the chart from the patient page", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    sessionStorage.clear();
    api.saveChart.mockImplementation(async (_p: string, changes: Record<string, string>) => ({ teeth: changes }));
  });

  test("REG-FE-CHART-005 a tap moves the tooth to the next condition and saves only that tooth", async () => {
    const { user } = await openChart({ UR6: "decayed" });
    api.dentalSummary.mockResolvedValue(summary({ UR6: "filled" }));
    api.saveChart.mockResolvedValue({ teeth: { UR6: "filled" } });
    await user.click(tooth("UR6"));
    expect(tooth("UR6")).toHaveAccessibleName("UR6 — Filled");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0].slice(0, 2)).toEqual(["pat_1", { UR6: "filled" }]);
  });

  test("REG-FE-CHART-006 the toast names the change, and Undo saves the tooth back", async () => {
    const { user } = await openChart({});
    api.saveChart.mockResolvedValueOnce({ teeth: { UL2: "healthy" } });
    api.dentalSummary.mockResolvedValue(summary({ UL2: "healthy" }));
    await user.click(tooth("UL2"));
    expect(tooth("UL2")).toHaveAccessibleName("UL2 — Healthy");
    const toast = await screen.findByText("UL2 → Healthy");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0][1]).toEqual({ UL2: "healthy" });

    api.saveChart.mockResolvedValueOnce({ teeth: {} });
    api.dentalSummary.mockResolvedValue(summary({}));
    const li = toast.closest("li") as HTMLElement;
    await user.click(within(li).getByRole("button", { name: "Undo" }));
    expect(tooth("UL2")).toHaveAccessibleName("UL2");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(api.saveChart.mock.calls[1][1]).toEqual({ UL2: "" });
  });

  test("REG-FE-CHART-007 quick taps on two teeth go out as one save with both changes", async () => {
    const { user } = await openChart({});
    api.saveChart.mockResolvedValue({ teeth: { UR1: "healthy", UR2: "healthy" } });
    await user.click(tooth("UR1"));
    await user.click(tooth("UR2"));
    await waitFor(() => expect(api.saveChart).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(api.saveChart.mock.calls[0][1]).toEqual({ UR1: "healthy", UR2: "healthy" });
  });

  test("REG-FE-CHART-008 a failed save puts the chart back to what the server holds", async () => {
    const { user } = await openChart({ LR6: "decayed" });
    api.saveChart.mockRejectedValue(new Error("offline"));
    await user.click(tooth("LR6"));
    expect(tooth("LR6")).toHaveAccessibleName("LR6 — Filled");
    await waitFor(() => expect(api.saveChart).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(tooth("LR6")).toHaveAccessibleName("LR6 — Decayed"));
    expect(await screen.findByText(/your last changes were undone/)).toBeInTheDocument();
  });

  test("REG-FE-CHART-009 the chart is shown as the server sent it", async () => {
    await openChart({ UR8: "decayed", LL1: "filled" });
    expect(tooth("UR8")).toHaveAccessibleName("UR8 — Decayed");
    expect(tooth("LL1")).toHaveAccessibleName("LL1 — Filled");
    await act(async () => {});
  });
});
