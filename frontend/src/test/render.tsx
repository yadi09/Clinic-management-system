// Shared harness for component tests: the providers a real page has (a fresh
// QueryClient with retries off, a MemoryRouter), a user-event instance, and a probe
// that shows the current URL so a test can assert on ?tab= / ?visit= without
// reaching into router internals.
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { vi } from "vitest";

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location" hidden>{loc.pathname + loc.search}</output>;
}

export function renderUI(ui: ReactElement, { route = "/" }: { route?: string } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const user = userEvent.setup();
  const r = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        {ui}
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...r, qc, user };
}

/** The URL the app is on now, e.g. "/appointments?tab=today". */
export const currentLocation = () => screen.getByTestId("location").textContent ?? "";

/** Freeze "today" for components that call new Date(). Only Date is faked, so the
 *  debounce timers and user-event keep running in real time. */
export function freezeToday(iso: string, hour = 9) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${iso}T${String(hour).padStart(2, "0")}:00:00`));
}

/**
 * A stand-in for apiFetch so a component's incidental queries (the patient for a
 * prescription header, the clinic's procedures, the services list) resolve to
 * something plausible instead of reaching the network. Tests mock the API module
 * they assert on separately; this only keeps the rest of the page quiet.
 */
export async function quietApiFetch(path: string): Promise<unknown> {
  if (/^\/patients\/[^/?]+$/.test(path)) {
    return {
      id: path.split("/")[2], mrn: "MRN-1", first_name: "Test", last_name: "Patient", gender: "female",
      dob: "1990-01-01", phone: "", allergies: [], created_at: "",
    };
  }
  if (path === "/org/clinic") return { name: "Test Clinic" };
  // Existing chart tests draw on the simple chart, the one every clinic had.
  if (path === "/dental/settings") return { chart_style: "simple" };
  return [];
}
