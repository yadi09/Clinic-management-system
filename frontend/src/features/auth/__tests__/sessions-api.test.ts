// The device-list calls: where each goes and what it carries.
import { beforeEach, describe, expect, test, vi } from "vitest";

const http = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), apiFetch: http.apiFetch }));

import { labelSessionApi, listSessionsApi, revokeSessionApi } from "@/features/auth/api";

beforeEach(() => http.apiFetch.mockReset().mockResolvedValue(undefined));

describe("REG-FE-SESS api", () => {
  test("REG-FE-SESS-020 list, sign one out, name one", async () => {
    await listSessionsApi();
    expect(http.apiFetch).toHaveBeenLastCalledWith("/auth/sessions");
    await revokeSessionApi("ses_b");
    expect(http.apiFetch).toHaveBeenLastCalledWith("/auth/sessions/ses_b", { method: "DELETE" });
    await labelSessionApi("ses_b", "Reception PC");
    expect(http.apiFetch).toHaveBeenLastCalledWith("/auth/sessions/ses_b/label", { method: "PUT", body: { label: "Reception PC" } });
  });
});
