// The line that says the server cannot be reached (FE-3).
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ConnectionBanner } from "@/components/ConnectionBanner";
import { setLink } from "@/lib/connection";

afterEach(() => act(() => setLink("ok")));

describe("REG-FE-CONN banner", () => {
  test("REG-FE-CONN-007 nothing is shown while the server answers", () => {
    render(<ConnectionBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  test("REG-FE-CONN-008 no connection: says changes may not be saved and that it clears by itself", () => {
    render(<ConnectionBanner />);
    act(() => setLink("down"));
    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("No connection to the server.");
    expect(bar).toHaveTextContent("Changes you make now may not be saved.");
    expect(bar).toHaveTextContent("clears by itself");
  });

  test("REG-FE-CONN-009 slow answers: says to check a change went through before repeating it", () => {
    render(<ConnectionBanner />);
    act(() => setLink("slow"));
    expect(screen.getByRole("status")).toHaveTextContent("The server is slow to answer.");
    expect(screen.getByRole("status")).toHaveTextContent("check they went through before doing them again");
  });

  test("REG-FE-CONN-010 it goes away when the server answers again", () => {
    render(<ConnectionBanner />);
    act(() => setLink("down"));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => setLink("ok"));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
