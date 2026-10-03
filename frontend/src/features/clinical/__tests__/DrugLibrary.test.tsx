// The drug library at the point of prescribing (the dental visit record's
// medication rows, and the general encounter's "new drug" dialog). What the
// prescriber relies on: typing searches the clinic's library; each result shows
// its saved defaults and allergen tags; picking hands the drug back; a name not
// in the library can be saved to it with defaults and allergen tags, then used;
// a refusal is shown and nothing is picked.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...(await import("@/test/frontdesk")).apiModule }));
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/frontdesk")).toastSpy }));

import type { Drug } from "@/features/clinical/api";
import { CreateDrugDialog, DrugSearchInput } from "@/features/clinical/DrugLibrary";
import { fail, fake, hang, resetToasts, toasts } from "@/test/frontdesk";
import { renderUI } from "@/test/render";

const drug = (id: string, name: string, over: Partial<Drug> = {}): Drug => ({ id, name, is_active: true, allergens: [], ...over });
const AMOX = drug("drg_1", "Amoxicillin 500mg", { default_dose: "1 cap", default_frequency: "TID", default_duration: "7 days", allergens: ["Penicillin"] });
const IBU = drug("drg_2", "Ibuprofen 400mg");

let picked: Drug[] = [];

function Harness({ initial = "", placeholder }: { initial?: string; placeholder?: string }) {
  const [v, setV] = useState(initial);
  return <DrugSearchInput value={v} onChange={setV} onPick={(d) => picked.push(d)} placeholder={placeholder} />;
}
const box = () => screen.getByPlaceholderText("Search the drug library…");

beforeEach(() => {
  fake.reset();
  resetToasts();
  picked = [];
  fake.on("GET", "/drugs", (r: { query: URLSearchParams }) => {
    const q = (r.query.get("search") ?? "").trim().toLowerCase();
    return [AMOX, IBU].filter((d) => d.name.toLowerCase().includes(q));
  });
  fake.on("GET", "/allergens", [{ id: "alg_1", name: "Penicillin", is_active: true }, { id: "alg_2", name: "Sulfa", is_active: true }]);
});

describe("REG-FE-DRUGLIB searching the library", () => {
  test("REG-FE-DRUGLIB-001 empty box: no list, no request; the default and a custom placeholder", async () => {
    const { unmount } = renderUI(<Harness />);
    expect(box()).toBeInTheDocument();
    fireEvent.focus(box());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(fake.sent("GET", "/drugs")).toHaveLength(0);
    unmount();
    renderUI(<Harness placeholder="Search the drug library, or type a new drug…" />);
    expect(screen.getByPlaceholderText("Search the drug library, or type a new drug…")).toBeInTheDocument();
  });

  test("REG-FE-DRUGLIB-002 typing searches; each result shows its defaults and allergen tags", async () => {
    const { user } = renderUI(<Harness />);
    await user.type(box(), "i");
    expect(fake.sent("GET", "/drugs").at(-1)?.query.get("search")).toBe("i");
    const amox = await screen.findByRole("button", { name: /Amoxicillin 500mg/ });
    expect(amox).toHaveTextContent("1 cap · TID · 7 days");
    expect(amox).toHaveTextContent("Penicillin");
    const ibu = screen.getByRole("button", { name: /Ibuprofen 400mg/ });
    expect(ibu).toHaveTextContent("no defaults saved");
    expect(screen.getByRole("button", { name: "Save “i” to the library" })).toBeInTheDocument();
  });

  test("REG-FE-DRUGLIB-003 picking a result hands back the drug and closes the list", async () => {
    const { user } = renderUI(<Harness />);
    await user.type(box(), "amox");
    await user.click(await screen.findByRole("button", { name: /Amoxicillin 500mg/ }));
    expect(picked).toEqual([AMOX]);
    expect(screen.queryByRole("button", { name: /Amoxicillin/ })).not.toBeInTheDocument();
  });

  test("REG-FE-DRUGLIB-004 an exact name (any case) offers no 'save to library'", async () => {
    const { user } = renderUI(<Harness />);
    await user.type(box(), "IBUPROFEN 400MG ");
    expect(await screen.findByRole("button", { name: /Ibuprofen 400mg/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /to the library/ })).not.toBeInTheDocument();
  });

  test("REG-FE-DRUGLIB-005 nothing found, or the search failed: only the offer to save the typed name", async () => {
    const { user } = renderUI(<Harness />);
    await user.type(box(), "zinc");
    expect(await screen.findByRole("button", { name: "Save “zinc” to the library" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fake.on("GET", "/drugs", fail(500, "down"));
    await user.type(box(), "x");
    expect(await screen.findByRole("button", { name: "Save “zincx” to the library" })).toBeInTheDocument();
  });

  test("REG-FE-DRUGLIB-006 focus reopens the list for a typed name; blur closes it after a moment", async () => {
    const { user } = renderUI(<Harness initial="amox" />);
    expect(screen.queryByRole("button", { name: /Amoxicillin/ })).not.toBeInTheDocument();
    await user.click(box());
    expect(await screen.findByRole("button", { name: /Amoxicillin/ })).toBeInTheDocument();
    // Under the clock sweep (FAKE_NOW) Date is already faked, and a second
    // useFakeTimers() does not add setTimeout to it, so the blur never closed. Start
    // over with both faked, keeping whatever "now" the run uses.
    const now = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now });
    try {
      fireEvent.blur(box());
      act(() => { vi.advanceTimersByTime(149); });
      expect(screen.getByRole("button", { name: /Amoxicillin/ })).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByRole("button", { name: /Amoxicillin/ })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test("REG-FE-DRUGLIB-007 whitespace only: no list", async () => {
    const { user } = renderUI(<Harness />);
    await user.type(box(), "   ");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(fake.sent("GET", "/drugs")).toHaveLength(0);
  });
});

describe("REG-FE-DRUGLIB adding a drug to the library", () => {
  test("REG-FE-DRUGLIB-008 'Save to library' opens the dialog with the typed name; Back returns to the search", async () => {
    const { user } = renderUI(<Harness />);
    await user.type(box(), "  Zinc 20mg");
    await user.click(await screen.findByRole("button", { name: "Save “Zinc 20mg” to the library" }));
    expect(screen.getByRole("dialog", { name: "New drug in library" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. Amoxicillin 500mg")).toHaveValue("Zinc 20mg");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(box()).toHaveValue("  Zinc 20mg");
  });

  test("REG-FE-DRUGLIB-009 saving sends the name, the four defaults and the chosen allergen tags, then picks the new drug", async () => {
    const created = drug("drg_9", "Zinc 20mg", { allergens: ["Sulfa"] });
    fake.on("POST", "/drugs", created);
    const { user } = renderUI(<Harness />);
    await user.type(box(), "Zinc 20mg");
    await user.click(await screen.findByRole("button", { name: /to the library/ }));
    await user.type(screen.getByPlaceholderText("1 cap"), "1 tab");
    await user.type(screen.getByPlaceholderText("three times a day"), "once daily");
    await user.type(screen.getByPlaceholderText("5 days"), "10 days");
    await user.type(screen.getByPlaceholderText("Complete the full course"), "With water");
    await user.click(await screen.findByRole("button", { name: "Sulfa" }));
    await user.click(screen.getByRole("button", { name: "Penicillin" }));
    await user.click(screen.getByRole("button", { name: "Penicillin" })); // toggled off again
    await user.click(screen.getByRole("button", { name: "Save & use" }));
    await waitFor(() => expect(picked).toEqual([created]));
    expect(fake.lastBody("POST", "/drugs")).toEqual({
      name: "Zinc 20mg", default_dose: "1 tab", default_frequency: "once daily", default_duration: "10 days",
      default_instructions: "With water", allergen_ids: ["alg_2"],
    });
    expect(toasts("success")).toEqual(["Saved to the drug library"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(box()).toBeInTheDocument();
  });

  test("REG-FE-DRUGLIB-010 a blank name cannot be saved", async () => {
    const { user } = renderUI(<CreateDrugDialog initialName="" onClose={() => {}} onCreated={() => {}} />);
    const save = screen.getByRole("button", { name: "Save & use" });
    expect(save).toBeDisabled();
    await user.type(screen.getByPlaceholderText("e.g. Amoxicillin 500mg"), "   ");
    expect(save).toBeDisabled();
    await user.type(screen.getByPlaceholderText("e.g. Amoxicillin 500mg"), "A");
    expect(save).toBeEnabled();
  });

  test("REG-FE-DRUGLIB-011 a refusal is shown (server message, or a generic one) and nothing is picked", async () => {
    const onCreated = vi.fn();
    fake.on("POST", "/drugs", fail(409, "A drug with that name already exists"));
    const { user } = renderUI(<CreateDrugDialog initialName="Amox" onClose={() => {}} onCreated={onCreated} />);
    await user.click(screen.getByRole("button", { name: "Save & use" }));
    await waitFor(() => expect(toasts("error")).toEqual(["A drug with that name already exists"]));
    fake.on("POST", "/drugs", () => { throw new TypeError("network"); });
    await user.click(screen.getByRole("button", { name: "Save & use" }));
    await waitFor(() => expect(toasts("error")).toEqual(["A drug with that name already exists", "Could not create the drug"]));
    expect(onCreated).not.toHaveBeenCalled();
  });

  test("REG-FE-DRUGLIB-012 no allergens yet: a hint; one added inline is tagged straight away", async () => {
    fake.on("GET", "/allergens", []);
    fake.on("POST", "/allergens", { id: "alg_new", name: "Latex", is_active: true });
    fake.on("POST", "/drugs", drug("drg_3", "Gloves"));
    const { user } = renderUI(<CreateDrugDialog initialName="Gloves" onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText("No allergens yet — add one below.")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("New allergen (e.g. Penicillin)"), "Latex");
    await user.click(screen.getByRole("button", { name: /^Add/ }));
    await waitFor(() => expect(fake.sent("POST", "/allergens")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Save & use" }));
    await waitFor(() => expect(fake.lastBody("POST", "/drugs")).toMatchObject({ allergen_ids: ["alg_new"] }));
  });

  test("REG-FE-DRUGLIB-013 Escape / closing the dialog calls onClose; saving shows the busy state", async () => {
    const onClose = vi.fn();
    fake.on("POST", "/drugs", hang);
    const { user } = renderUI(<CreateDrugDialog initialName="Amox" onClose={onClose} onCreated={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Save & use" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save & use/ })).toBeDisabled());
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
