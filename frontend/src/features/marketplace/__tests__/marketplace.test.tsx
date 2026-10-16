import { describe, expect, test, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { renderUI } from "@/test/render";
import * as api from "@/features/marketplace/api";
import { MarketLayout } from "@/features/marketplace/parts";
import { MarketHomePage } from "@/features/marketplace/MarketHomePage";
import { MarketListingPage } from "@/features/marketplace/ListingPage";
import { MarketSellPage } from "@/features/marketplace/SellPage";

vi.mock("@/features/marketplace/api", async (orig) => ({
  ...(await orig<typeof import("@/features/marketplace/api")>()),
  browse: vi.fn(),
  getListing: vi.fn(),
  contactSeller: vi.fn(),
  signUp: vi.fn(),
  login: vi.fn(),
  getMe: vi.fn(),
}));

const listing = (over: Partial<api.Listing> = {}): api.Listing => ({
  id: "l1", title: "Filtek Z250 composite", brand: "3M", category: "Restorative", condition: "new",
  price_etb: 1200, negotiable: true, photos: [], status: "active", created_at: "2026-10-16T00:00:00Z",
  seller: { id: "s1", kind: "supplier", name: "Habesha Dental", city: "Addis Ababa", channels: ["call", "telegram"] },
  ...over,
});

function app(route: string) {
  return renderUI(
    <Routes>
      <Route path="/marketplace" element={<MarketLayout />}>
        <Route index element={<MarketHomePage />} />
        <Route path="listing/:id" element={<MarketListingPage />} />
        <Route path="sell" element={<MarketSellPage />} />
      </Route>
    </Routes>,
    { route },
  );
}

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

describe("marketplace", () => {
  test("REG-FE-MKT-001 browse shows each product with its condition, and a used one is marked used", async () => {
    vi.mocked(api.browse).mockResolvedValue({
      total: 2,
      items: [listing(), listing({ id: "l2", title: "Dental chair unit", condition: "used_good", price_etb: undefined })],
    });
    app("/marketplace");
    expect(await screen.findByText("Filtek Z250 composite")).toBeInTheDocument();
    // "Brand new" is both the filter chip and the first card's tag.
    expect(screen.getAllByText("Brand new")).toHaveLength(2);
    expect(screen.getByText("Used – good")).toBeInTheDocument();
    expect(screen.getByText("Ask for price")).toBeInTheDocument();
  });

  test("REG-FE-MKT-002 an empty search says nothing matches instead of showing a blank page", async () => {
    vi.mocked(api.browse).mockResolvedValue({ total: 0, items: [] });
    const { user } = app("/marketplace");
    await user.type(await screen.findByLabelText("Search products"), "zzz");
    expect(await screen.findByText("Nothing matches yet")).toBeInTheDocument();
  });

  test("REG-FE-MKT-003 the phone is only revealed by tapping Call, which asks the server", async () => {
    vi.mocked(api.getListing).mockResolvedValue(listing());
    vi.mocked(api.contactSeller).mockResolvedValue({ channel: "call", href: "tel:0911000000", phone: "0911000000" });
    vi.spyOn(window, "open").mockImplementation(() => null);
    const { user } = app("/marketplace/listing/l1");
    expect(await screen.findByText("Habesha Dental")).toBeInTheDocument();
    expect(screen.queryByText("0911000000")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /call/i }));
    await waitFor(() => expect(api.contactSeller).toHaveBeenCalledWith("l1", "call"));
    expect(await screen.findByText("0911000000")).toBeInTheDocument();
  });

  test("REG-FE-MKT-004 a listing that is gone says so", async () => {
    vi.mocked(api.getListing).mockRejectedValue(new Error("gone"));
    app("/marketplace/listing/zzz");
    expect(await screen.findByText("This listing is no longer available")).toBeInTheDocument();
  });

  test("REG-FE-MKT-005 the seller application needs a password of 6+ characters before it can be sent", async () => {
    const { user } = app("/marketplace/sell");
    const send = await screen.findByRole("button", { name: "Send application" });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText(/Name or business name/), "Habesha Dental");
    await user.type(screen.getByLabelText(/^Phone/), "0911000000");
    await user.type(screen.getByLabelText(/^City/), "Addis Ababa");
    await user.type(screen.getByLabelText(/Choose a password/), "abc");
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText(/Choose a password/), "def");
    expect(send).toBeEnabled();
  });
});
