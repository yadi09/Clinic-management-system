// The device-list calls: where each goes and what it carries.
import { beforeEach, describe, expect, test, vi } from "vitest";

const http = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), apiFetch: http.apiFetch }));

import { labelSessionApi, listSessionsApi, listWorkspacesApi, revokeSessionApi, switchWorkspaceApi } from "@/features/auth/api";

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

  test("REG-FE-BRWS-020 the clinic's branches, and moving into one (never retried on a 401: a refused switch is an answer)", async () => {
    await listWorkspacesApi();
    expect(http.apiFetch).toHaveBeenLastCalledWith("/auth/workspaces");
    await switchWorkspaceApi("ten_bole");
    expect(http.apiFetch).toHaveBeenLastCalledWith("/auth/switch-workspace", { method: "POST", body: { workspace_id: "ten_bole" }, retry: false });
  });
});
