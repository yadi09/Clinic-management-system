import { describe, expect, test, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";

import { renderUI } from "@/test/render";
import * as api from "@/features/marketplace/api";
import { MarketLayout } from "@/features/marketplace/parts";
import { MarketHomePage } from "@/features/marketplace/MarketHomePage";
import { MarketListingPage } from "@/features/marketplace/ListingPage";
import { MarketSellPage } from "@/features/marketplace/SellPage";
import { MarketStorePage } from "@/features/marketplace/StorefrontPage";
import { SellerPortal } from "@/features/marketplace/SellerPortal";

vi.mock("@/features/marketplace/api", async (orig) => ({
  ...(await orig<typeof import("@/features/marketplace/api")>()),
  browse: vi.fn(),
  getListing: vi.fn(),
  contactSeller: vi.fn(),
  signUp: vi.fn(),
  login: vi.fn(),
  getMe: vi.fn(),
  getStore: vi.fn(),
  myStats: vi.fn(),
  myListings: vi.fn(),
  changeSlug: vi.fn(),
}));

const listing = (over: Partial<api.Listing> = {}): api.Listing => ({
  id: "l1", title: "Filtek Z250 composite", brand: "3M", category: "Restorative", condition: "new",
  price_etb: 1200, negotiable: true, photos: [], status: "active", created_at: "2026-10-16T00:00:00Z",
  seller: { id: "s1", kind: "supplier", name: "Habesha Dental", slug: "habesha-dental", city: "Addis Ababa", channels: ["call", "telegram"] },
  ...over,
});

function app(route: string) {
  return renderUI(
    <Routes>
      <Route path="/marketplace" element={<MarketLayout />}>
        <Route index element={<MarketHomePage />} />
        <Route path="listing/:id" element={<MarketListingPage />} />
        <Route path="s/:slug" element={<MarketStorePage />} />
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

  test("REG-FE-MKT-006 a storefront shows the seller and searches only that seller's products", async () => {
    vi.mocked(api.getStore).mockResolvedValue({
      total: 2,
      seller: { id: "s1", kind: "supplier", name: "Habesha Dental", slug: "habesha-dental", city: "Addis Ababa", about: "Composites and burs", channels: ["call"] },
      categories: [{ category: "Restorative", count: 1 }, { category: "Instruments", count: 1 }],
    });
    vi.mocked(api.browse).mockResolvedValue({ total: 1, items: [listing()] });
    app("/marketplace/s/habesha-dental");
    expect(await screen.findByRole("heading", { name: "Habesha Dental" })).toBeInTheDocument();
    expect(await screen.findByText("Filtek Z250 composite")).toBeInTheDocument();
    // Only this seller's categories are offered, and every search carries the seller.
    expect(screen.getByRole("button", { name: "Instruments" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Implants" })).not.toBeInTheDocument();
    expect(vi.mocked(api.browse).mock.calls.every(([f]) => f.seller === "habesha-dental")).toBe(true);
    expect(screen.queryByLabelText("City")).not.toBeInTheDocument();
  });

  test("REG-FE-MKT-007 a store that is not approved says it is not available", async () => {
    vi.mocked(api.getStore).mockRejectedValue(new Error("gone"));
    app("/marketplace/s/nobody");
    expect(await screen.findByText("This store is not available")).toBeInTheDocument();
  });

  test("REG-FE-MKT-008 the seller sees their store link only once approved, and can rename it once", async () => {
    vi.mocked(api.myStats).mockResolvedValue({ listings: 0, active: 0, contacts_30d: 4, visits_30d: 61 });
    vi.mocked(api.myListings).mockResolvedValue([]);
    vi.mocked(api.changeSlug).mockResolvedValue({} as api.Seller);
    const base: api.Seller = {
      id: "s1", kind: "supplier", name: "Habesha Dental", phone: "0911000000", city: "Addis Ababa", slug: "habesha-dental",
      slug_changed: false, status: "pending", created_at: "2026-10-16T00:00:00Z", listings: 0,
    };
    const first = renderUI(<SellerPortal seller={base} onSignOut={() => {}} />);
    await screen.findByText("Waiting for our call");
    expect(screen.queryByText("Your store link")).not.toBeInTheDocument();
    first.unmount();

    const { user } = renderUI(<SellerPortal seller={{ ...base, status: "approved" }} onSignOut={() => {}} />);
    expect(await screen.findByText("Your store link")).toBeInTheDocument();
    expect(screen.getByLabelText("Store link")).toHaveValue(`${window.location.origin}/marketplace/s/habesha-dental`);
    expect(await screen.findByText((_, el) => el?.tagName === "P" && /Store visits \(30 days\):\s*61/.test(el.textContent ?? ""))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change link name" }));
    const input = screen.getByLabelText("Link name");
    await user.clear(input);
    await user.type(input, "Habesha-Dental-Supply");
    await user.click(screen.getByRole("button", { name: "Save new link" }));
    await waitFor(() => expect(api.changeSlug).toHaveBeenCalledWith("habesha-dental-supply"));

    // Once it has been changed the option is gone.
    renderUI(<SellerPortal seller={{ ...base, status: "approved", slug_changed: true }} onSignOut={() => {}} />);
    await screen.findAllByText("Your store link");
    expect(screen.getAllByRole("button", { name: "Change link name" })).toHaveLength(1);
  });
});
