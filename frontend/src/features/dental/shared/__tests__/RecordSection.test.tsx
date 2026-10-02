// The card each part of a visit record sits on, and what an empty part says.
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Pill } from "lucide-react";

import { EmptySlot, RecordSection } from "@/features/dental/shared/RecordSection";

describe("REG-FE-SHARED record sections", () => {
  test("REG-FE-SHARED-061 a section shows its title, hint, count, action and content", () => {
    render(
      <RecordSection icon={Pill} title="Prescriptions" hint="Medication the patient takes home." count={3}
        action={<button>Add prescription</button>} tone="rx">
        <p>body</p>
      </RecordSection>,
    );
    expect(screen.getByRole("heading", { name: /Prescriptions/ })).toHaveTextContent("Prescriptions3");
    expect(screen.getByText("Medication the patient takes home.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add prescription" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  test("REG-FE-SHARED-062 no count pill for zero or no count; no hint or action slot when not given", () => {
    const { container, rerender } = render(<RecordSection icon={Pill} title="Images" count={0}><p>x</p></RecordSection>);
    expect(screen.getByRole("heading")).toHaveTextContent(/^Images$/);
    expect(container.querySelector("header p")).toBeNull();
    expect(container.querySelector("header > .shrink-0:not(span)")).toBeNull();
    rerender(<RecordSection icon={Pill} title="Images"><p>x</p></RecordSection>);
    expect(screen.getByRole("heading")).toHaveTextContent(/^Images$/);
  });

  test("REG-FE-SHARED-063 each tone tints the icon differently; default when not given", () => {
    const tints: Record<string, string> = { default: "bg-muted", clinical: "bg-brand/10", rx: "bg-emerald-100", media: "bg-violet-100" };
    for (const [tone, cls] of Object.entries(tints)) {
      const { container, unmount } = render(
        <RecordSection icon={Pill} title="T" tone={tone as "default"}><p>x</p></RecordSection>,
      );
      expect(container.querySelector("header > span")).toHaveClass(cls);
      unmount();
    }
    const { container } = render(<RecordSection icon={Pill} title="T"><p>x</p></RecordSection>);
    expect(container.querySelector("header > span")).toHaveClass("bg-muted");
  });

  test("REG-FE-SHARED-064 an empty slot names the thing, says when you'd want it, and centres the action", () => {
    const { rerender } = render(<EmptySlot icon={Pill} title="No prescription" hint="Write one if needed." action={<button>Write</button>} />);
    expect(screen.getByText("No prescription")).toBeInTheDocument();
    expect(screen.getByText("Write one if needed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write" })).toBeInTheDocument();
    rerender(<EmptySlot icon={Pill} title="No prescription" />);
    expect(screen.queryByText("Write one if needed.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
