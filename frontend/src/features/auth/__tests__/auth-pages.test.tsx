// Getting in: workspace + email + password, a second factor when the account has
// one, and an invitation (or reset) link that sets a password. Every refusal is the
// server's own words; a lockout must read as a lockout.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 20_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
const authApi = vi.hoisted(() => ({ loginApi: vi.fn(), verifyMfaApi: vi.fn() }));
vi.mock("@/features/auth/api", async (orig) => ({ ...(await orig<object>()), ...authApi }));
const client = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...client }));

import { LoginPage } from "@/features/auth/pages/LoginPage";
import { MfaPage } from "@/features/auth/pages/MfaPage";
import { AcceptInvitePage } from "@/features/auth/pages/AcceptInvitePage";
import { AuthLayout } from "@/app/layouts/AuthLayout";
import { loginSchema, mfaSchema } from "@/features/auth/schemas";
import * as authApiReal from "@/features/auth/api";
import { AppError } from "@/lib/api-client";
import { authFns, deferred, setAuth } from "@/test/admin";
import { currentLocation, renderUI } from "@/test/render";

const USER = { id: "u1", tenant_id: "t1", email: "dr@cure.et", full_name: "Dr Selam", roles: ["dentist"] };
const TOKEN = { access_token: "tok", token_type: "Bearer", expires_in: 900, user: USER };

function app(route: string) {
  const r = renderUI(
    <Routes>
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mfa" element={<MfaPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
      </Route>
      <Route path="/" element={<p>Dashboard</p>} />
      <Route path="/chairside" element={<p>Chairside</p>} />
    </Routes>,
    { route },
  );
  return r;
}

beforeEach(() => setAuth({ status: "unauthenticated", user: null }));

async function fillLogin(user: ReturnType<typeof userEvent.setup>, ws = "cure", email = "dr@cure.et", pw = "secret-pw") {
  if (ws) await user.type(screen.getByLabelText("Workspace"), ws);
  if (email) await user.type(screen.getByLabelText("Email"), email);
  if (pw) await user.type(screen.getByLabelText("Password"), pw);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("REG-FE-LOGIN sign in", () => {
  test("REG-FE-LOGIN-001 each field says what is missing before anything is sent", async () => {
    const { user } = app("/login");
    expect(screen.getByText("ClinicOS")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Workspace is required")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email")).toBeInTheDocument();
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email")).toBeInTheDocument();
    expect(authApi.loginApi).not.toHaveBeenCalled();
  });

  test("REG-FE-LOGIN-002 a good sign-in starts the session and goes home", async () => {
    authApi.loginApi.mockResolvedValue(TOKEN);
    const { user } = app("/login");
    await fillLogin(user);
    expect(authApi.loginApi).toHaveBeenCalledWith({ workspace: "cure", email: "dr@cure.et", password: "secret-pw" });
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(authFns.signIn).toHaveBeenCalledWith("tok", USER);
  });

  test("REG-FE-LOGIN-003 sent here from a page: back to that page after signing in", async () => {
    authApi.loginApi.mockResolvedValue(TOKEN);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: { pathname: "/chairside" } } }]}>
        <Routes><Route path="/login" element={<LoginPage />} /><Route path="/chairside" element={<p>Chairside</p>} /></Routes>
      </MemoryRouter>,
    );
    await fillLogin(userEvent.setup());
    expect(await screen.findByText("Chairside")).toBeInTheDocument();
  });

  test("REG-FE-LOGIN-004 wrong password and lockout: the server's words, and the form stays", async () => {
    const { user } = app("/login");
    authApi.loginApi.mockRejectedValueOnce(new AppError(401, "BAD_CREDENTIALS", "Wrong workspace, email or password."));
    await fillLogin(user);
    expect(await screen.findByText("Wrong workspace, email or password.")).toBeInTheDocument();
    authApi.loginApi.mockRejectedValueOnce(new AppError(423, "ACCOUNT_LOCKED", "Too many attempts. Try again in 15 minutes."));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Too many attempts. Try again in 15 minutes.")).toBeInTheDocument();
    expect(screen.queryByText("Wrong workspace, email or password.")).not.toBeInTheDocument();
    expect(authFns.signIn).not.toHaveBeenCalled();
    expect(currentLocation()).toBe("/login");
  });

  test("REG-FE-LOGIN-005 a network failure is a plain sentence, not a stack trace", async () => {
    authApi.loginApi.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { user } = app("/login");
    await fillLogin(user);
    expect(await screen.findByText("Unable to sign in. Please try again.")).toBeInTheDocument();
  });

  test("REG-FE-LOGIN-006 the button says it is working and cannot be pressed twice", async () => {
    const d = deferred<typeof TOKEN>();
    authApi.loginApi.mockReturnValueOnce(d.promise);
    const { user } = app("/login");
    await fillLogin(user);
    expect(await screen.findByRole("button", { name: "Signing in…" })).toBeDisabled();
    d.resolve(TOKEN);
    await waitFor(() => expect(currentLocation()).toBe("/"));
  });

  test("REG-FE-LOGIN-007 an account with MFA goes to the code screen, carrying the challenge", async () => {
    authApi.loginApi.mockResolvedValue({ mfa_required: true, mfa_token: "mfa-1" });
    const { user } = app("/login");
    await fillLogin(user);
    expect(await screen.findByRole("button", { name: "Verify" })).toBeInTheDocument();
    expect(currentLocation()).toBe("/mfa");
    expect(authFns.signIn).not.toHaveBeenCalled();

    // …and the code completes the sign-in.
    authApi.verifyMfaApi.mockResolvedValue(TOKEN);
    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(authApi.verifyMfaApi).toHaveBeenCalledWith({ mfa_token: "mfa-1", code: "123456" });
    expect(authFns.signIn).toHaveBeenCalledWith("tok", USER);
  });

  test("REG-FE-LOGIN-008 the schemas: workspace, email and password; a 6-digit code", () => {
    expect(loginSchema.safeParse({ workspace: "cure", email: "a@b.co", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ workspace: "", email: "a@b.co", password: "x" }).success).toBe(false);
    expect(mfaSchema.safeParse({ code: "123456" }).success).toBe(true);
    for (const code of ["12345", "1234567", "12a456"]) expect(mfaSchema.safeParse({ code }).success).toBe(false);
  });
});

describe("REG-FE-MFA second factor", () => {
  async function toMfa() {
    authApi.loginApi.mockResolvedValue({ mfa_required: true, mfa_token: "mfa-1" });
    const r = app("/login");
    await fillLogin(r.user);
    await screen.findByRole("button", { name: "Verify" });
    return r;
  }

  test("REG-FE-MFA-001 opened without a challenge: back to sign-in", async () => {
    app("/mfa");
    await waitFor(() => expect(currentLocation()).toBe("/login"));
  });

  test("REG-FE-MFA-002 the code must be six digits", async () => {
    const { user } = await toMfa();
    await user.type(screen.getByLabelText("Authentication code"), "12ab");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Enter the 6-digit code")).toBeInTheDocument();
    expect(authApi.verifyMfaApi).not.toHaveBeenCalled();
  });

  test("REG-FE-MFA-003 a wrong or expired code is said; a network failure is a plain sentence", async () => {
    const { user } = await toMfa();
    authApi.verifyMfaApi.mockRejectedValueOnce(new AppError(401, "MFA_INVALID", "That code is not right."));
    await user.type(screen.getByLabelText("Authentication code"), "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("That code is not right.")).toBeInTheDocument();
    authApi.verifyMfaApi.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Verification failed. Please try again.")).toBeInTheDocument();
    expect(authFns.signIn).not.toHaveBeenCalled();
  });
});

describe("REG-FE-INVITE accept invitation / reset password", () => {
  test("REG-FE-INVITE-001 no token in the link: says the link is broken, no form", () => {
    app("/accept-invite");
    expect(screen.getByText("This invitation link is invalid or incomplete.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });

  test("REG-FE-INVITE-002 password at least 8 characters and both boxes must match", async () => {
    const { user } = app("/accept-invite?token=inv-1");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.click(screen.getByRole("button", { name: "Activate account" }));
    expect(await screen.findByText("At least 8 characters")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "long-enough");
    await user.type(screen.getByLabelText("Confirm password"), "different!");
    await user.click(screen.getByRole("button", { name: "Activate account" }));
    expect(await screen.findByText("Passwords do not match")).toBeInTheDocument();
    expect(client.apiFetch).not.toHaveBeenCalled();
  });

  test("REG-FE-INVITE-003 an invitation signs the new staff member in and goes home", async () => {
    client.apiFetch.mockResolvedValue(TOKEN);
    const { user } = app("/accept-invite?token=inv-1");
    await user.type(screen.getByLabelText("Password"), "long-enough");
    await user.type(screen.getByLabelText("Confirm password"), "long-enough");
    await user.click(screen.getByRole("button", { name: "Activate account" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(client.apiFetch).toHaveBeenCalledWith("/auth/accept-invite",
      { method: "POST", body: { token: "inv-1", password: "long-enough" }, auth: false, retry: false });
    expect(authFns.signIn).toHaveBeenCalledWith("tok", USER);
  });

  test("REG-FE-INVITE-004 a password reset does NOT sign in: it says every device was signed out", async () => {
    client.apiFetch.mockResolvedValue({ sign_in_required: true });
    const { user } = app("/accept-invite?token=rst-1");
    await user.type(screen.getByLabelText("Password"), "long-enough");
    await user.type(screen.getByLabelText("Confirm password"), "long-enough");
    await user.click(screen.getByRole("button", { name: "Activate account" }));
    expect(await screen.findByText(/every device that was signed in has been signed out/)).toBeInTheDocument();
    expect(authFns.signIn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Go to sign in" }));
    expect(currentLocation()).toBe("/login");
  });

  test("REG-FE-INVITE-005 a used or expired link: the server's words; anything else: a plain sentence", async () => {
    client.apiFetch.mockRejectedValueOnce(new AppError(410, "TOKEN_EXPIRED", "This link has expired. Ask for a new one."));
    const { user } = app("/accept-invite?token=old");
    await user.type(screen.getByLabelText("Password"), "long-enough");
    await user.type(screen.getByLabelText("Confirm password"), "long-enough");
    await user.click(screen.getByRole("button", { name: "Activate account" }));
    expect(await screen.findByText("This link has expired. Ask for a new one.")).toBeInTheDocument();
    client.apiFetch.mockRejectedValueOnce(new Error("x"));
    await user.click(screen.getByRole("button", { name: "Activate account" }));
    expect(await screen.findByText("Could not accept the invitation.")).toBeInTheDocument();
  });
});

describe("REG-FE-AUTHAPI auth endpoints", () => {
  test("REG-FE-AUTHAPI-001 each call goes to its endpoint with the right refresh rules", async () => {
    client.apiFetch.mockResolvedValue({});
    const real = await vi.importActual<typeof authApiReal>("@/features/auth/api");
    await real.switchBranchApi("br_2");
    await real.loginApi({ workspace: "w", email: "e", password: "p" });
    await real.verifyMfaApi({ mfa_token: "m", code: "1" });
    await real.meApi();
    await real.logoutApi();
    await real.changePasswordApi({ current_password: "a", new_password: "b" });
    await real.changeEmailApi({ new_email: "x@y.z", current_password: "a" });
    await real.signOutOtherDevicesApi();
    const urls = client.apiFetch.mock.calls.map((c) => [c[0], c[1]?.method ?? "GET", c[1]?.auth, c[1]?.retry]);
    expect(urls).toEqual([
      ["/auth/switch-branch", "POST", undefined, false],
      ["/auth/login", "POST", false, false],
      ["/auth/mfa", "POST", false, false],
      ["/auth/me", "GET", undefined, undefined],
      ["/auth/logout", "POST", false, false],
      ["/auth/password", "POST", undefined, undefined],
      ["/auth/email", "POST", undefined, undefined],
      ["/auth/sessions/logout-others", "POST", undefined, undefined],
    ]);
    expect(real.isMfaChallenge({ mfa_required: true, mfa_token: "x" })).toBe(true);
    expect(real.isMfaChallenge(TOKEN)).toBe(false);
  });
});
