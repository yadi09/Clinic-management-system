// The clinic's priced procedure list at the point of choosing one: pick from it, type
// a name that is not on it, or (for dental.manage) add to it from the chair. Plus the
// list-price note that sits beside the amount being charged.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const billing = vi.hoisted(() => ({ listServices: vi.fn(), createService: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const auth = vi.hoisted(() => ({ perms: new Set<string>() }));
vi.mock("@/features/billing/api", async (orig) => ({ ...(await orig<object>()), ...billing }));
vi.mock("sonner", async (orig) => ({ ...(await orig<object>()), toast }));
vi.mock("@/lib/api-client", async (orig) => {
  const { quietApiFetch } = await import("@/test/render");
  return { ...(await orig<object>()), apiFetch: vi.fn(quietApiFetch) };
});
vi.mock("@/app/auth-context", () => ({
  useAuth: () => ({ can: (p: string) => auth.perms.has(p), flagOn: () => true, user: { id: "u1", full_name: "Dr Test" }, activeBranchId: null }),
}));

import { PriceAgainstList, ServicePicker } from "@/features/dental/shared/ServicePicker";
import type { ServiceItem } from "@/features/billing/api";
import { AppError } from "@/lib/api-client";
import { renderUI } from "@/test/render";

const svc = (id: string, name: string, price: string, extra: Partial<ServiceItem> = {}): ServiceItem =>
  ({ id, code: id.toUpperCase(), name, category: "dental", price, currency: "ETB", is_active: true, is_default: false, ...extra }) as ServiceItem;

const LIST = [
  svc("rct", "Root canal", "4500"),
  svc("ext", "Extraction", "1200", { category: " Dental ", code: "EXO" }),
  svc("old", "Retired crown", "9000", { is_active: false }),
  svc("cbc", "Blood count", "300", { category: "lab" }),
];

function picker(props: Partial<Parameters<typeof ServicePicker>[0]> = {}) {
  const onPick = vi.fn();
  const onFreeText = vi.fn();
  const r = renderUI(<ServicePicker value="" onPick={onPick} onFreeText={onFreeText} {...props} />);
  return { ...r, onPick, onFreeText };
}
const trigger = () => screen.getByRole("combobox");
const search = () => screen.getByPlaceholderText("Search the clinic's list…");

describe("REG-FE-SHARED ServicePicker", () => {
  beforeEach(() => {
    Object.values(billing).forEach((f) => f.mockReset());
    billing.listServices.mockResolvedValue(LIST);
    toast.success.mockReset(); toast.error.mockReset();
    auth.perms = new Set();
  });

  test("REG-FE-SHARED-101 the trigger shows the chosen name, else the placeholder, else a default prompt", () => {
    const a = picker();
    expect(trigger()).toHaveTextContent("Choose a procedure");
    a.unmount();
    const b = picker({ placeholder: "What treatment?" });
    expect(trigger()).toHaveTextContent("What treatment?");
    b.unmount();
    picker({ value: "Root canal", placeholder: "What treatment?" });
    expect(trigger()).toHaveTextContent("Root canal");
  });

  test("REG-FE-SHARED-102 lists only the clinic's active dental procedures, priced; fetched including inactive", async () => {
    const { user } = picker();
    await user.click(trigger());
    expect(await screen.findByRole("option", { name: /Root canal/ })).toHaveTextContent("4,500 ETB");
    expect(screen.getByRole("option", { name: /Extraction/ })).toHaveTextContent("1,200 ETB");
    expect(screen.queryByRole("option", { name: /Retired crown/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Blood count/ })).not.toBeInTheDocument();
    expect(billing.listServices).toHaveBeenCalledWith(false);
  });

  test("REG-FE-SHARED-103 search filters by name or code, ignoring case and spaces", async () => {
    const { user } = picker();
    await user.click(trigger());
    await screen.findByRole("option", { name: /Root canal/ });
    await user.type(search(), "  ROOT");
    expect(screen.getByRole("option", { name: /Root canal/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Extraction/ })).not.toBeInTheDocument();
    await user.clear(search());
    await user.type(search(), "exo");
    expect(screen.getByRole("option", { name: /Extraction/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Root canal/ })).not.toBeInTheDocument();
  });

  test("REG-FE-SHARED-104 choosing an entry reports its id, name and list price, and closes", async () => {
    const { user, onPick } = picker();
    await user.click(trigger());
    await user.click(await screen.findByRole("option", { name: /Extraction/ }));
    expect(onPick).toHaveBeenCalledWith({ id: "ext", name: "Extraction", price: "1200" });
    await waitFor(() => expect(screen.queryByPlaceholderText("Search the clinic's list…")).not.toBeInTheDocument());
  });

  test("REG-FE-SHARED-105 the selected entry carries the tick, the others do not", async () => {
    const { user } = picker({ value: "Root canal", selectedId: "rct" });
    await user.click(trigger());
    const ticks = (name: RegExp) => screen.getByRole("option", { name }).querySelector("svg")!;
    await screen.findByRole("option", { name: /Root canal/ });
    expect(ticks(/Root canal/).getAttribute("class")).toContain("opacity-100");
    expect(ticks(/Extraction/).getAttribute("class")).toContain("opacity-0");
  });

  test("REG-FE-SHARED-106 an empty list says how to start one; not while it is still loading", async () => {
    let resolve!: (v: ServiceItem[]) => void;
    billing.listServices.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { user } = picker();
    await user.click(trigger());
    expect(screen.queryByText(/No priced procedures yet/)).not.toBeInTheDocument();
    resolve([svc("cbc", "Blood count", "300", { category: "lab" })]);
    expect(await screen.findByText(/No priced procedures yet/)).toBeInTheDocument();
  });

  test("REG-FE-SHARED-107 a typed name can be used without a price: free text reported, selection cleared", async () => {
    const { user, onPick, onFreeText } = picker();
    await user.click(trigger());
    await screen.findByRole("option", { name: /Root canal/ });
    expect(screen.queryByRole("button", { name: /without a price/ })).not.toBeInTheDocument();
    await user.type(search(), "  Veneer  ");
    await user.click(screen.getByRole("button", { name: /^Use “\s*Veneer\s*” without a price$/ }));
    expect(onFreeText).toHaveBeenCalledWith("Veneer");
    expect(onPick).toHaveBeenCalledWith(null);
    await waitFor(() => expect(screen.queryByPlaceholderText("Search the clinic's list…")).not.toBeInTheDocument());
  });

  test("REG-FE-SHARED-108 only dental.manage may add to the clinic's list", async () => {
    const { user, unmount } = picker();
    await user.click(trigger());
    await screen.findByRole("option", { name: /Root canal/ });
    expect(screen.queryByRole("button", { name: /Add a procedure to the clinic's list/ })).not.toBeInTheDocument();
    unmount();
    auth.perms = new Set(["dental.manage"]);
    const again = picker();
    await again.user.click(trigger());
    expect(await screen.findByRole("button", { name: /Add a procedure to the clinic's list/ })).toBeInTheDocument();
  });

  test("REG-FE-SHARED-109 adding a procedure: prefilled with the search, derived code, priced, picked, list refreshed", async () => {
    auth.perms = new Set(["dental.manage"]);
    billing.createService.mockResolvedValue(svc("new", "Root canal — molar", "4500"));
    const { user, onPick } = picker();
    await user.click(trigger());
    await screen.findByRole("option", { name: /Root canal/ });
    await user.type(search(), "Root canal — molar");
    await user.click(screen.getByRole("button", { name: /Add a procedure to the clinic's list/ }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Add a procedure")).toBeInTheDocument();
    expect(within(dlg).getByLabelText("Procedure")).toHaveValue("Root canal — molar");
    fireEvent.change(within(dlg).getByLabelText("Price (ETB)"), { target: { value: "4500" } });
    const calls = billing.listServices.mock.calls.length;
    await user.click(within(dlg).getByRole("button", { name: "Add to list" }));
    await waitFor(() => expect(billing.createService).toHaveBeenCalledWith({
      code: "ROOT-CANAL-MOLAR", name: "Root canal — molar", category: "dental", price: 4500, assignable_by: "clinician",
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Root canal — molar added to the clinic's list"));
    expect(onPick).toHaveBeenCalledWith({ id: "new", name: "Root canal — molar", price: "4500" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(billing.listServices.mock.calls.length).toBeGreaterThan(calls));
  });

  test("REG-FE-SHARED-110 the add dialog falls back to the current value; a blank name cannot be added", async () => {
    auth.perms = new Set(["dental.manage"]);
    const { user } = picker({ value: "Scaling" });
    await user.click(trigger());
    await user.click(await screen.findByRole("button", { name: /Add a procedure/ }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByLabelText("Procedure")).toHaveValue("Scaling");
    fireEvent.change(within(dlg).getByLabelText("Procedure"), { target: { value: "   " } });
    expect(within(dlg).getByRole("button", { name: "Add to list" })).toBeDisabled();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(billing.createService).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-111 an unpriced or symbol-only name still gets a code and a zero price; long codes are cut to 24", async () => {
    auth.perms = new Set(["dental.manage"]);
    billing.createService.mockResolvedValue(svc("n", "x", "0"));
    const { user } = picker();
    await user.click(trigger());
    await user.click(await screen.findByRole("button", { name: /Add a procedure/ }));
    let dlg = screen.getByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Procedure"), { target: { value: " — " } });
    await user.click(within(dlg).getByRole("button", { name: "Add to list" }));
    await waitFor(() => expect(billing.createService).toHaveBeenLastCalledWith(expect.objectContaining({ code: "PROCEDURE", name: "—", price: 0 })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(trigger());
    await user.click(await screen.findByRole("button", { name: /Add a procedure/ }));
    dlg = screen.getByRole("dialog");
    fireEvent.change(within(dlg).getByLabelText("Procedure"), { target: { value: "Full mouth rehabilitation with implants" } });
    await user.click(within(dlg).getByRole("button", { name: "Add to list" }));
    await waitFor(() => expect(billing.createService).toHaveBeenLastCalledWith(expect.objectContaining({ code: "FULL-MOUTH-REHABILITATIO" })));
  });

  test("REG-FE-SHARED-112 a refused add is toasted (server's words, else plain) and the dialog stays", async () => {
    auth.perms = new Set(["dental.manage"]);
    billing.createService.mockRejectedValueOnce(new AppError(409, "duplicate", "That code is taken"));
    billing.createService.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { user, onPick } = picker({ value: "Veneer" });
    await user.click(trigger());
    await user.click(await screen.findByRole("button", { name: /Add a procedure/ }));
    const add = within(screen.getByRole("dialog")).getByRole("button", { name: "Add to list" });
    await user.click(add);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That code is taken"));
    await user.click(add);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not add it to the list"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  test("REG-FE-SHARED-113 Add to list is disabled while the request runs (no duplicate entries)", async () => {
    auth.perms = new Set(["dental.manage"]);
    billing.createService.mockReturnValue(new Promise(() => {}));
    const { user } = picker({ value: "Veneer" });
    await user.click(trigger());
    await user.click(await screen.findByRole("button", { name: /Add a procedure/ }));
    const add = within(screen.getByRole("dialog")).getByRole("button", { name: "Add to list" });
    await user.click(add);
    await waitFor(() => expect(add).toBeDisabled());
    await user.click(add);
    expect(billing.createService).toHaveBeenCalledTimes(1);
  });
});

describe("REG-FE-SHARED PriceAgainstList", () => {
  test("REG-FE-SHARED-114 says nothing when there is no list price", () => {
    const a = render(<PriceAgainstList charging="500" />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = render(<PriceAgainstList list="0" charging="500" />);
    expect(b.container).toBeEmptyDOMElement();
  });

  test("REG-FE-SHARED-115 at list price (within half a birr) it just quotes the list", () => {
    const a = render(<PriceAgainstList list="4500" charging="4500" />);
    expect(a.container).toHaveTextContent("List price 4,500 ETB.");
    a.unmount();
    render(<PriceAgainstList list="4500" charging="4500.4" />);
    expect(screen.getByText("List price 4,500 ETB.")).toBeInTheDocument();
  });

  test("REG-FE-SHARED-116 below list reads as a discount, above it as above list", () => {
    const a = render(<PriceAgainstList list="4500" charging="4000" />);
    expect(a.container).toHaveTextContent("List price 4,500 ETB — 500 ETB discount");
    expect(screen.getByText("500 ETB discount").className).toContain("emerald");
    a.unmount();
    render(<PriceAgainstList list="4500" charging="5000" />);
    expect(screen.getByText("500 ETB above list").className).toContain("amber");
  });
});
