// Getting in: which clinic (remembered by the browser, or from the clinic's own
// link), then email + password, a second factor when the account has one, and an
// invitation (or reset) link that sets a password. Every refusal says what to do
// next; a lockout must read as a lockout.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 60_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
const authApi = vi.hoisted(() => ({ loginApi: vi.fn(), verifyMfaApi: vi.fn(), clinicCardApi: vi.fn() }));
vi.mock("@/features/auth/api", async (orig) => ({ ...(await orig<object>()), ...authApi }));
const client = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...client }));

import { LoginPage } from "@/features/auth/pages/LoginPage";
import { MfaPage } from "@/features/auth/pages/MfaPage";
import { AcceptInvitePage } from "@/features/auth/pages/AcceptInvitePage";
import { AuthLayout } from "@/app/layouts/AuthLayout";
import { clinicCodeSchema, credentialsSchema, loginSchema, mfaSchema } from "@/features/auth/schemas";
import { normalizeClinicCode } from "@/features/auth/clinic-memory";
import * as authApiReal from "@/features/auth/api";
import { AppError } from "@/lib/api-client";
import { authFns, deferred, setAuth } from "@/test/admin";
import { currentLocation, renderUI } from "@/test/render";

const USER = { id: "u1", tenant_id: "t1", email: "dr@cure.et", full_name: "Dr Selam", roles: ["dentist"] };
const TOKEN = { access_token: "tok", token_type: "Bearer", expires_in: 900, user: USER };
const CURE = { name: "Cure Dental", slug: "cure", has_logo: false };
const REMEMBER = "clinicos.login.clinic";

function app(route: string) {
  return renderUI(
    <Routes>
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login/:clinic" element={<LoginPage />} />
        <Route path="/mfa" element={<MfaPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
      </Route>
      <Route path="/" element={<p>Dashboard</p>} />
      <Route path="/chairside" element={<p>Chairside</p>} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  setAuth({ status: "unauthenticated", user: null });
  localStorage.clear();
  sessionStorage.clear();
  authApi.clinicCardApi.mockImplementation(async (code: string) => {
    if (code === "cure") return CURE;
    throw new AppError(404, "CLINIC_NOT_FOUND", "no clinic with that code");
  });
});

type U = ReturnType<typeof userEvent.setup>;

/** Step one: type a clinic code and continue to that clinic's sign-in. */
async function pickClinic(user: U, code = "cure") {
  await user.type(await screen.findByLabelText("Clinic code"), code);
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

/** Step two: email and password at the clinic already chosen. */
async function signInAs(user: U, email = "dr@cure.et", pw = "secret-pw") {
  if (email) await user.type(await screen.findByLabelText("Email"), email);
  if (pw) await user.type(screen.getByLabelText("Password"), pw);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

async function fillLogin(user: U) {
  await pickClinic(user);
  await signInAs(user);
}

describe("REG-FE-LOGIN sign in", () => {
  test("REG-FE-LOGIN-009 sent here because the session ended: the page says why, once", async () => {
    sessionStorage.setItem("clinicos.session_end", "clinic-suspended");
    const first = app("/login");
    expect(screen.getByText("This clinic's workspace has been suspended. Please contact ClinicOS support.")).toBeInTheDocument();
    first.unmount();
    sessionStorage.setItem("clinicos.session_end", "expired");
    localStorage.setItem(REMEMBER, "cure");
    const second = app("/login");
    // Shown on the remembered clinic's sign-in too.
    expect(await screen.findByText("Cure Dental")).toBeInTheDocument();
    expect(screen.getByText("Your session has ended. Please sign in again.")).toBeInTheDocument();
    second.unmount();
    // Read once: a later visit shows the plain form.
    app("/login");
    expect(await screen.findByText("Cure Dental")).toBeInTheDocument();
    expect(screen.queryByText(/session has ended|has been suspended/)).not.toBeInTheDocument();
  });

  test("REG-FE-LOGIN-010 a browser that blocks storage still gets a working sign-in form", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    authApi.loginApi.mockResolvedValue(TOKEN);
    const { user } = app("/login");
    expect(screen.queryByText(/session has ended|has been suspended/)).not.toBeInTheDocument();
    await fillLogin(user);
    await waitFor(() => expect(currentLocation()).toBe("/"));
    get.mockRestore();
    set.mockRestore();
  });

  test("REG-FE-LOGIN-001 each field says what is missing before anything is sent", async () => {
    const { user } = app("/login");
    expect(screen.getAllByText("ClinicOS").length).toBeGreaterThan(0);
    // Step one: the clinic code.
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Enter your clinic code")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Clinic code"), "cure!");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Use letters, numbers and dashes only")).toBeInTheDocument();
    expect(authApi.clinicCardApi).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Clinic code"));
    await pickClinic(user);
    // Step two: email and password.
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your email")).toBeInTheDocument();
    expect(screen.getByText("Enter your password")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("That doesn't look like an email")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(authApi.loginApi).not.toHaveBeenCalled();
  });

  test("REG-FE-LOGIN-002 a good sign-in starts the session, goes home, and the browser remembers the clinic", async () => {
    authApi.loginApi.mockResolvedValue(TOKEN);
    const { user } = app("/login");
    // Typed the way people type: capitals and a space.
    await pickClinic(user, " Cure ");
    expect(authApi.clinicCardApi).toHaveBeenCalledWith("cure");
    expect(await screen.findByText("Cure Dental")).toBeInTheDocument();
    expect(localStorage.getItem(REMEMBER)).toBeNull(); // not before the sign-in proves it
    await signInAs(user);
    expect(authApi.loginApi).toHaveBeenCalledWith({ workspace: "cure", email: "dr@cure.et", password: "secret-pw" });
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(authFns.signIn).toHaveBeenCalledWith("tok", USER);
    expect(localStorage.getItem(REMEMBER)).toBe("cure");
  });

  test("REG-FE-LOGIN-003 sent here from a page: back to that page after signing in", async () => {
    authApi.loginApi.mockResolvedValue(TOKEN);
    localStorage.setItem(REMEMBER, "cure");
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: { pathname: "/chairside" } } }]}>
        <Routes><Route path="/login" element={<LoginPage />} /><Route path="/chairside" element={<p>Chairside</p>} /></Routes>
      </MemoryRouter>,
    );
    await signInAs(userEvent.setup());
    expect(await screen.findByText("Chairside")).toBeInTheDocument();
  });

  test("REG-FE-LOGIN-004 each refusal says what happened and what to do; the form stays", async () => {
    const { user } = app("/login");
    await pickClinic(user);
    authApi.loginApi.mockRejectedValueOnce(new AppError(401, "UNAUTHENTICATED", "invalid credentials"));
    await signInAs(user);
    expect(await screen.findByText(/That email and password don't match an account at Cure Dental/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveFocus();
    const cases: [AppError, RegExp][] = [
      [new AppError(401, "ACCOUNT_LOCKED", "account temporarily locked after failed attempts"), /Too many wrong tries\. This account is paused for 15 minutes/],
      [new AppError(403, "ACCOUNT_INACTIVE", "account is not active"), /Your account at Cure Dental is switched off/],
      [new AppError(403, "TENANT_INACTIVE", "this workspace is not active"), /Cure Dental's ClinicOS workspace is paused/],
      [new AppError(429, "RATE_LIMITED", "too many requests"), /Too many tries from this connection/],
      [new AppError(500, "INTERNAL", "boom"), /ClinicOS had a problem signing you in/],
      [new AppError(400, "VALIDATION", "workspace, a valid email, and password are required"), /workspace, a valid email, and password are required/],
    ];
    for (const [err, text] of cases) {
      authApi.loginApi.mockRejectedValueOnce(err);
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
    expect(screen.queryByText(/don't match an account/)).not.toBeInTheDocument();
    expect(authFns.signIn).not.toHaveBeenCalled();
    expect(currentLocation()).toBe("/login");
    // Never proven right: not remembered.
    expect(localStorage.getItem(REMEMBER)).toBeNull();
  });

  test("REG-FE-LOGIN-005 no connection is a plain sentence, not a stack trace", async () => {
    const { user } = app("/login");
    await pickClinic(user);
    authApi.loginApi.mockRejectedValueOnce(new AppError(0, "NETWORK", "x"));
    await signInAs(user);
    expect(await screen.findByText("Can't reach ClinicOS. Check the internet connection and try again.")).toBeInTheDocument();
    authApi.loginApi.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Can't reach ClinicOS. Check the internet connection and try again.")).toBeInTheDocument();
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

  test("REG-FE-LOGIN-007 an account with MFA goes to the code screen, carrying the challenge and the clinic", async () => {
    authApi.loginApi.mockResolvedValue({ mfa_required: true, mfa_token: "mfa-1" });
    const { user } = app("/login");
    await fillLogin(user);
    expect(await screen.findByRole("button", { name: "Verify" })).toBeInTheDocument();
    expect(currentLocation()).toBe("/mfa");
    expect(screen.getByText("Cure Dental")).toBeInTheDocument();
    expect(screen.getByText("dr@cure.et")).toBeInTheDocument();
    expect(authFns.signIn).not.toHaveBeenCalled();
    // The password proved the code right.
    expect(localStorage.getItem(REMEMBER)).toBe("cure");

    // …and the sixth digit completes the sign-in on its own.
    authApi.verifyMfaApi.mockResolvedValue(TOKEN);
    await user.type(screen.getByLabelText("Authentication code"), "123456");
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(authApi.verifyMfaApi).toHaveBeenCalledTimes(1);
    expect(authApi.verifyMfaApi).toHaveBeenCalledWith({ mfa_token: "mfa-1", code: "123456" });
    expect(authFns.signIn).toHaveBeenCalledWith("tok", USER);
  });

  test("REG-FE-LOGIN-008 the schemas: clinic code, email and password; a 6-digit code", () => {
    expect(loginSchema.safeParse({ workspace: "cure", email: "a@b.co", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ workspace: "", email: "a@b.co", password: "x" }).success).toBe(false);
    expect(clinicCodeSchema.safeParse({ code: "cure-dental-2" }).success).toBe(true);
    for (const code of ["", "-cure", "cure dental", "cure!"]) expect(clinicCodeSchema.safeParse({ code }).success).toBe(false);
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(credentialsSchema.safeParse({ email: "a@b", password: "" }).success).toBe(false);
    expect(normalizeClinicCode("  Cure  Dental ")).toBe("cure-dental");
    expect(mfaSchema.safeParse({ code: "123456" }).success).toBe(true);
    for (const code of ["12345", "1234567", "12a456"]) expect(mfaSchema.safeParse({ code }).success).toBe(false);
  });

  test("REG-FE-LOGIN-011 a remembered clinic opens straight on its sign-in; Change forgets it", async () => {
    localStorage.setItem(REMEMBER, "cure");
    const { user } = app("/login");
    expect(await screen.findByText("Cure Dental")).toBeInTheDocument();
    expect(screen.queryByLabelText("Clinic code")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Change clinic (now Cure Dental)" }));
    expect(screen.getByLabelText("Clinic code")).toHaveValue("");
    expect(localStorage.getItem(REMEMBER)).toBeNull();
  });

  test("REG-FE-LOGIN-012 a clinic's own link chooses the clinic: /login/<code> and ?clinic=<code>", async () => {
    const one = app("/login/cure");
    expect(await screen.findByText("Cure Dental")).toBeInTheDocument();
    one.unmount();
    const two = app("/login?clinic=CURE");
    expect(await screen.findByText("Cure Dental")).toBeInTheDocument();
    // Changing clinic leaves the clinic's link.
    await two.user.click(screen.getByRole("button", { name: /Change clinic/ }));
    await waitFor(() => expect(currentLocation()).toBe("/login"));
    expect(await screen.findByLabelText("Clinic code")).toBeInTheDocument();
  });

  test("REG-FE-LOGIN-013 an unknown code is said under the field; a remembered one that stopped working asks again", async () => {
    const { user, unmount } = app("/login");
    await pickClinic(user, "nope");
    expect(await screen.findByText(/We can't find an open clinic with the code "nope"/)).toBeInTheDocument();
    expect(screen.getByLabelText("Clinic code")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    unmount();
    localStorage.setItem(REMEMBER, "gone-clinic");
    app("/login");
    expect(await screen.findByText(/We can't find an open clinic with the code "gone-clinic"/)).toBeInTheDocument();
    expect(screen.getByLabelText("Clinic code")).toHaveValue("gone-clinic");
  });

  test("REG-FE-LOGIN-014 the clinic can't be checked (offline): sign-in still offered under its code", async () => {
    authApi.clinicCardApi.mockRejectedValue(new AppError(0, "NETWORK", "x"));
    authApi.loginApi.mockResolvedValue(TOKEN);
    const { user } = app("/login");
    await pickClinic(user, "cure");
    expect(await screen.findByTestId("clinic-name")).toHaveTextContent("cure");
    await signInAs(user);
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(authApi.loginApi).toHaveBeenCalledWith({ workspace: "cure", email: "dr@cure.et", password: "secret-pw" });
  });

  test("REG-FE-LOGIN-015 Forgot password explains the clinic resets it, and comes back", async () => {
    localStorage.setItem(REMEMBER, "cure");
    const { user } = app("/login");
    await user.click(await screen.findByRole("button", { name: "Forgot password?" }));
    expect(screen.getByText("For your safety, passwords are reset by your clinic, not by email.")).toBeInTheDocument();
    expect(screen.getByText(/Tell your clinic owner or admin at Cure Dental/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  test("REG-FE-LOGIN-016 the password can be shown, and Caps Lock is pointed out", async () => {
    localStorage.setItem(REMEMBER, "cure");
    const { user } = app("/login");
    const pw = await screen.findByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(pw).toHaveAttribute("type", "password");
    await user.click(pw);
    await user.keyboard("{CapsLock}A");
    expect(await screen.findByText("⇪ Caps Lock is on")).toBeInTheDocument();
    await user.keyboard("{CapsLock}a");
    await waitFor(() => expect(screen.queryByText("⇪ Caps Lock is on")).not.toBeInTheDocument());
  });

  test("REG-FE-LOGIN-017 the clinic's logo when it has one; its initials when it has none or the image fails", async () => {
    authApi.clinicCardApi.mockResolvedValue({ ...CURE, has_logo: true });
    localStorage.setItem(REMEMBER, "cure");
    const { container } = app("/login");
    await screen.findByText("Cure Dental");
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/v1/verify/logo/cure");
    img.dispatchEvent(new Event("error"));
    expect(await screen.findByText("CD")).toBeInTheDocument();
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

  test("REG-FE-MFA-002 the code must be six digits; letters never get in", async () => {
    const { user } = await toMfa();
    await user.type(screen.getByLabelText("Authentication code"), "12ab");
    expect(screen.getByLabelText("Authentication code")).toHaveValue("12");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("Enter the 6-digit code")).toBeInTheDocument();
    expect(authApi.verifyMfaApi).not.toHaveBeenCalled();
  });

  test("REG-FE-MFA-003 a wrong code is said and cleared; no connection is a plain sentence", async () => {
    const { user } = await toMfa();
    authApi.verifyMfaApi.mockRejectedValueOnce(new AppError(401, "UNAUTHENTICATED", "invalid credentials"));
    await user.type(screen.getByLabelText("Authentication code"), "000000");
    expect(await screen.findByText(/That code isn't right, or it has expired/)).toBeInTheDocument();
    expect(screen.getByLabelText("Authentication code")).toHaveValue("");
    authApi.verifyMfaApi.mockRejectedValueOnce(new Error("offline"));
    await user.type(screen.getByLabelText("Authentication code"), "111111");
    expect(await screen.findByText("Can't reach ClinicOS. Check the internet connection and try again.")).toBeInTheDocument();
    expect(authFns.signIn).not.toHaveBeenCalled();
  });

  test("REG-FE-MFA-004 a pasted code with spaces signs in on its own", async () => {
    const { user } = await toMfa();
    authApi.verifyMfaApi.mockResolvedValue(TOKEN);
    await user.click(screen.getByLabelText("Authentication code"));
    await user.paste("123 456");
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(authApi.verifyMfaApi).toHaveBeenCalledWith({ mfa_token: "mfa-1", code: "123456" });
  });

  test("REG-FE-MFA-005 a way back to another account, and help for a lost phone", async () => {
    const { user } = await toMfa();
    await user.click(screen.getByRole("button", { name: "Lost your phone?" }));
    expect(screen.getByText(/reset two-step sign-in for your account/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "← Use another account" }));
    await waitFor(() => expect(currentLocation()).toBe("/login"));
    // The clinic is remembered: straight back to its sign-in.
    expect(await screen.findByText("Cure Dental")).toBeInTheDocument();
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
    await real.clinicCardApi("cure dental");
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
      ["/auth/clinic/cure%20dental", "GET", false, false],
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
