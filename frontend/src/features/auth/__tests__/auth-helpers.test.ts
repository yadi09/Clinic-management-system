// The small pieces behind the sign-in page: what each refusal tells the person, the
// one remembered clinic code, and the clinic's initials when it has no logo.
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { codeError, signInError } from "@/features/auth/messages";
import { normalizeClinicCode, rememberedClinic } from "@/features/auth/clinic-memory";
import { ClinicBadge } from "@/features/auth/ClinicBadge";
import { AppError } from "@/lib/api-client";

const OFFLINE = "Can't reach ClinicOS. Check the internet connection and try again.";

describe("REG-FE-LOGINMSG what a refusal says", () => {
  test("REG-FE-LOGINMSG-001 sign-in: every server answer maps to a next step", () => {
    expect(signInError(new Error("x"), "Cure")).toBe(OFFLINE);
    expect(signInError(new AppError(0, "TIMEOUT", "x"), "Cure")).toBe(OFFLINE);
    expect(signInError(new AppError(401, "UNAUTHENTICATED", "invalid credentials"), "Cure")).toMatch(/at Cure\. Check both/);
    expect(signInError(new AppError(502, "UPSTREAM_ERROR", "x"), "Cure")).toMatch(/had a problem signing you in/);
    expect(signInError(new AppError(400, "VALIDATION", ""), "Cure")).toBe("Unable to sign in. Please try again.");
  });

  test("REG-FE-LOGINMSG-002 the code step: wrong, offline, too many, server trouble, anything else", () => {
    expect(codeError("x")).toBe(OFFLINE);
    expect(codeError(new AppError(0, "NETWORK", "x"))).toBe(OFFLINE);
    expect(codeError(new AppError(0, "TIMEOUT", "x"))).toBe(OFFLINE);
    expect(codeError(new AppError(401, "UNAUTHENTICATED", "invalid or expired challenge"))).toMatch(/isn't right, or it has expired/);
    expect(codeError(new AppError(429, "RATE_LIMITED", "too many requests"))).toMatch(/Too many tries/);
    expect(codeError(new AppError(500, "INTERNAL", "x"))).toMatch(/had a problem checking the code/);
    expect(codeError(new AppError(400, "VALIDATION", "mfa_token and code are required"))).toBe("mfa_token and code are required");
    expect(codeError(new AppError(400, "VALIDATION", ""))).toBe("Verification failed. Please try again.");
  });
});

describe("REG-FE-LOGINMEM the remembered clinic", () => {
  test("REG-FE-LOGINMEM-001 one code, set and cleared; blocked storage is never an error", () => {
    rememberedClinic.set("cure");
    expect(rememberedClinic.get()).toBe("cure");
    rememberedClinic.clear();
    expect(rememberedClinic.get()).toBeNull();
    const blocked = () => { throw new DOMException("blocked", "SecurityError"); };
    const spies = (["getItem", "setItem", "removeItem"] as const).map((m) => vi.spyOn(Storage.prototype, m).mockImplementation(blocked));
    expect(() => rememberedClinic.set("cure")).not.toThrow();
    expect(rememberedClinic.get()).toBeNull();
    expect(() => rememberedClinic.clear()).not.toThrow();
    spies.forEach((s) => s.mockRestore());
    expect(normalizeClinicCode("\tBole  Family ")).toBe("bole-family");
  });
});

describe("REG-FE-LOGINBADGE the clinic's initials", () => {
  test.each([
    ["Cure Dental", "CD"],
    ["Hayat", "HA"],
    ["St. Paul's - Bole", "SP"],
    ["!!!", "?"],
  ])("REG-FE-LOGINBADGE-001 %s → %s", (name, initials) => {
    render(createElement(ClinicBadge, { clinic: { name, slug: "x", has_logo: false } }));
    expect(screen.getByText(initials)).toBeInTheDocument();
  });
});
