// The record shelf: one reference panel at a time, picked from a rail, remembered per
// patient, and never throwing away a panel's half-finished work when you switch away.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PanelBody, PanelCard, PanelHeader, RecordShelf, SHELF_ICONS, type ShelfPanel } from "@/features/dental/shelf/RecordShelf";

function Draft() {
  const [v, setV] = useState("");
  return <input aria-label="draft" value={v} onChange={(e) => setV(e.target.value)} />;
}

const panels = (extra: Partial<Record<string, Partial<ShelfPanel>>> = {}): ShelfPanel[] => [
  { key: "timeline", label: "Timeline", icon: SHELF_ICONS.CalendarRange, badge: 4, render: () => <p>timeline body</p>, ...extra.timeline },
  { key: "exam", label: "Examinations", icon: SHELF_ICONS.Stethoscope, render: () => <Draft />, ...extra.exam },
  { key: "money", label: "Money", icon: SHELF_ICONS.Receipt, badge: "!", render: () => <p>money body</p>, ...extra.money },
];
const tab = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

describe("REG-FE-TREATMENTS the record shelf", () => {
  beforeEach(() => { sessionStorage.clear(); window.history.replaceState({}, "", "/"); });
  afterEach(() => window.history.replaceState({}, "", "/"));

  test("REG-FE-TREATMENTS-001 opens on the first panel, rail shows every panel with its badge", () => {
    render(<RecordShelf patientId="p1" panels={panels()} />);
    expect(screen.getByRole("navigation", { name: "Patient record" })).toBeInTheDocument();
    expect(tab("Timeline")).toHaveAttribute("aria-current", "page");
    expect(tab("Timeline")).toHaveTextContent("Timeline4");
    expect(tab("Money")).toHaveTextContent("Money!");
    expect(tab("Examinations")).not.toHaveAttribute("aria-current");
    expect(screen.getByText("timeline body")).toBeVisible();
    // Unvisited panels are not rendered at all.
    expect(screen.queryByText("money body")).not.toBeInTheDocument();
  });

  test("REG-FE-TREATMENTS-002 picking a panel switches to it and remembers it for that patient", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<RecordShelf patientId="p1" panels={panels()} />);
    await user.click(tab("Money"));
    expect(tab("Money")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("money body")).toBeVisible();
    expect(sessionStorage.getItem("dental-shelf:p1")).toBe("money");
    unmount();
    render(<RecordShelf patientId="p1" panels={panels()} />);
    expect(tab("Money")).toHaveAttribute("aria-current", "page");
  });

  test("REG-FE-TREATMENTS-003 the remembered panel is per patient, not global", () => {
    sessionStorage.setItem("dental-shelf:p1", "money");
    render(<RecordShelf patientId="p2" panels={panels()} />);
    expect(tab("Timeline")).toHaveAttribute("aria-current", "page");
  });

  test("REG-FE-TREATMENTS-004 a ?panel= link wins over the remembered panel; an unknown one is ignored", () => {
    sessionStorage.setItem("dental-shelf:p1", "exam");
    window.history.replaceState({}, "", "/patients/p1?panel=money");
    const { unmount } = render(<RecordShelf patientId="p1" panels={panels()} />);
    expect(tab("Money")).toHaveAttribute("aria-current", "page");
    unmount();
    window.history.replaceState({}, "", "/patients/p1?panel=nope");
    render(<RecordShelf patientId="p1" panels={panels()} />);
    expect(tab("Examinations")).toHaveAttribute("aria-current", "page");
  });

  test("REG-FE-TREATMENTS-005 a remembered panel that no longer exists falls back to the first", () => {
    sessionStorage.setItem("dental-shelf:p1", "images");
    render(<RecordShelf patientId="p1" panels={panels()} />);
    expect(tab("Timeline")).toHaveAttribute("aria-current", "page");
  });

  test("REG-FE-TREATMENTS-006 switching away keeps a half-written panel alive (hidden, not unmounted)", async () => {
    const user = userEvent.setup();
    render(<RecordShelf patientId="p1" panels={panels()} />);
    await user.click(tab("Examinations"));
    await user.type(screen.getByLabelText("draft"), "caries on 36");
    await user.click(tab("Timeline"));
    const hiddenDraft = screen.getByLabelText("draft", { selector: "input" }) as HTMLInputElement;
    expect(hiddenDraft).not.toBeVisible();
    await user.click(tab("Examinations"));
    expect(screen.getByLabelText("draft")).toHaveValue("caries on 36");
  });

  test("REG-FE-TREATMENTS-007 if the active panel disappears, the shelf shows the first rather than a blank", async () => {
    const user = userEvent.setup();
    const all = panels();
    const { rerender } = render(<RecordShelf patientId="p1" panels={all} />);
    await user.click(tab("Money"));
    rerender(<RecordShelf patientId="p1" panels={all.filter((p) => p.key !== "money")} />);
    expect(tab("Timeline")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("timeline body")).toBeVisible();
  });

  test("REG-FE-TREATMENTS-008 no panels at all renders nothing", () => {
    const { container } = render(<RecordShelf patientId="p1" panels={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("REG-FE-TREATMENTS-009 Panel chrome: bare drops the card, otherwise a card with header/body", () => {
    const { container, rerender } = render(
      <PanelCard bare className="x"><PanelHeader bare>H</PanelHeader><PanelBody bare className="b">B</PanelBody></PanelCard>,
    );
    expect(container.firstElementChild).toHaveClass("x");
    expect(container.firstElementChild).not.toHaveClass("rounded-lg");
    expect(screen.getByText("H")).toHaveClass("mb-3");
    expect(screen.getByText("B")).toHaveClass("b");
    rerender(<PanelCard className="x"><PanelHeader>H</PanelHeader><PanelBody>B</PanelBody></PanelCard>);
    expect(container.firstElementChild).toHaveClass("rounded-lg");
    expect(screen.getByText("H")).not.toHaveClass("mb-3");
    expect(screen.getByText("B")).toBeInTheDocument();
  });
});
