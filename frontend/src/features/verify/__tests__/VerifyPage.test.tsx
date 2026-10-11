// What someone sees after scanning the QR on a prescription. The answer comes first,
// in words, and says what to do; the record's details follow; and a paper that was
// withdrawn or replaced shows no medicines at all.
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Route, Routes } from "react-router-dom";

const client = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api-client", async (orig) => ({ ...(await orig<object>()), ...client }));

import { AppError } from "@/lib/api-client";
import { VerifyEntryPage } from "@/features/verify/VerifyEntryPage";
import { VerifyPage } from "@/features/verify/VerifyPage";
import type { CheckResult } from "@/features/verify/api";
import { currentLocation, renderUI } from "@/test/render";

const TOKEN = "abcdefghijklmnopqrstuvwxyz";

const result = (over: Partial<CheckResult> = {}): CheckResult => ({
  status: "genuine", kind: "dental_rx", ref: "Rx 7gbzsm", clinic: "Cure Dental Clinic", branch: "Bole branch", slug: "cure-dental",
  has_logo: false, written_at: "2026-10-11", days_ago: 1,
  patient: { name: "Abebe K.", age: 29, gender: "male" }, prescriber: "Dr Yonas Bekele",
  medicines: [
    { name: "Amoxicillin 500 mg capsule", dose: "1 capsule", frequency: "3 times a day", duration: "7 days", instructions: "Finish the course" },
    { name: "Ibuprofen 400 mg tablet", dose: "1 tablet", frequency: "3 times a day", duration: "3 days" },
  ],
  note: "Review in one week.", checks: { before: 0 }, ...over,
});

const open = (key = TOKEN) => renderUI(
  <Routes><Route path="/v/:slug/:key" element={<VerifyPage />} /><Route path="/v" element={<VerifyEntryPage />} /></Routes>,
  { route: `/v/cure-dental/${key}` },
);

describe("REG-FE-VERIFY the page a scan opens", () => {
  beforeEach(() => { client.apiFetch.mockReset(); });

  test("REG-FE-VERIFY-001 a genuine paper: the answer, who issued it, every medicine with its dose, the patient, doctor, dates and reference", async () => {
    client.apiFetch.mockResolvedValue(result());
    open();
    expect(await screen.findByRole("heading", { name: "Genuine prescription" })).toBeInTheDocument();
    expect(client.apiFetch).toHaveBeenCalledWith(`/verify/t/cure-dental/${TOKEN}`, { auth: false });
    expect(screen.getByRole("status")).toHaveTextContent("Issued by Cure Dental Clinic yesterday");
    expect(screen.getByText("Cure Dental Clinic", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("Bole branch")).toBeInTheDocument();

    const meds = screen.getByRole("list", { name: "Medicines" });
    expect(within(meds).getByText("Amoxicillin 500 mg capsule")).toBeInTheDocument();
    for (const t of ["1 capsule", "7 days", "1 tablet", "3 days"]) expect(within(meds).getAllByText(t).length).toBeGreaterThan(0);
    expect(within(meds).getByText("Finish the course")).toBeInTheDocument();
    expect(screen.getByText("Note:")).toBeInTheDocument();

    expect(screen.getByText(/Abebe K\. · 29 years · male/)).toBeInTheDocument();
    expect(screen.getByText("Dr Yonas Bekele")).toBeInTheDocument();
    // Both calendars, because the paper in the hand may carry either.
    expect(screen.getByText(/11 Oct 2026/)).toBeInTheDocument();
    expect(screen.getByText(/1 Tikimt 2019/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy reference Rx 7gbzsm" })).toBeInTheDocument();
    expect(screen.getByText(/first time this paper has been checked/)).toBeInTheDocument();
  });

  test("REG-FE-VERIFY-002 a paper looked at before says how often and when first, as a note and not an accusation", async () => {
    client.apiFetch.mockResolvedValue(result({ checks: { before: 2, first_at: "2026-10-11T07:40:00Z" } }));
    open();
    expect(await screen.findByText(/Checked 2 times before/)).toBeInTheDocument();
    expect(screen.getByText(/first on 11 Oct, 10:40/)).toBeInTheDocument();
    expect(screen.getByText(/ask the patient/)).toBeInTheDocument();
    expect(screen.queryByText(/first time this paper/)).not.toBeInTheDocument();
  });

  test("REG-FE-VERIFY-003 past its validity: amber, until when, and the medicines are still shown to read", async () => {
    client.apiFetch.mockResolvedValue(result({ status: "expired", valid_until: "2026-10-14", days_ago: 9 }));
    open();
    expect(await screen.findByRole("heading", { name: "Past its validity" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("valid until 14 Oct 2026");
    expect(screen.getByText("Amoxicillin 500 mg capsule")).toBeInTheDocument();
  });

  test("REG-FE-VERIFY-004 cancelled: says do not dispense and shows no medicines, patient or doctor", async () => {
    client.apiFetch.mockResolvedValue(result({ status: "cancelled", medicines: undefined, patient: undefined, prescriber: undefined, note: undefined }));
    open();
    expect(await screen.findByRole("heading", { name: "Cancelled by the clinic" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Do not dispense.");
    expect(screen.queryByText("Amoxicillin 500 mg capsule")).not.toBeInTheDocument();
    expect(screen.queryByText("Dr Yonas Bekele")).not.toBeInTheDocument();
    expect(screen.queryByText("Medicines")).not.toBeInTheDocument();
    // Whose paper it was and which one is still said, so a pharmacist can tell the clinic.
    expect(screen.getByText("Rx 7gbzsm")).toBeInTheDocument();
  });

  test("REG-FE-VERIFY-005 changed after printing: a newer version exists, nothing to dispense from", async () => {
    client.apiFetch.mockResolvedValue(result({ status: "superseded", medicines: undefined, patient: undefined, prescriber: undefined }));
    open();
    expect(await screen.findByRole("heading", { name: "A newer version exists" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Do not dispense from this paper.");
    expect(screen.queryByText("Amoxicillin 500 mg capsule")).not.toBeInTheDocument();
  });

  test("REG-FE-VERIFY-006 handed over already by the clinic's own pharmacy: said before the medicines", async () => {
    client.apiFetch.mockResolvedValue(result({ dispensed_at: "2026-10-11T09:00:00+03:00" }));
    open();
    expect(await screen.findByRole("heading", { name: "Already dispensed" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("11 Oct 2026");
    expect(screen.queryByRole("heading", { name: "Genuine prescription" })).not.toBeInTheDocument();
  });

  test("REG-FE-VERIFY-007 not found: plain words, no account needed, and a way to type the code by hand", async () => {
    client.apiFetch.mockRejectedValue(new AppError(404, "PAPER_NOT_FOUND", "this paper could not be found"));
    open();
    expect(await screen.findByRole("heading", { name: "We could not find this paper" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter it here" })).toHaveAttribute("href", "/v");
  });

  test("REG-FE-VERIFY-008 too many tries, or no connection: a clear message and a retry that asks again", async () => {
    client.apiFetch.mockRejectedValueOnce(new AppError(429, "RATE_LIMITED", "slow down"));
    const { user } = open();
    expect(await screen.findByRole("heading", { name: "Too many tries" })).toBeInTheDocument();
    client.apiFetch.mockRejectedValueOnce(new Error("Failed to fetch"));
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Could not reach the check" })).toBeInTheDocument();
    client.apiFetch.mockResolvedValueOnce(result());
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Genuine prescription" })).toBeInTheDocument();
    expect(client.apiFetch).toHaveBeenCalledTimes(3);
  });

  test("REG-FE-VERIFY-009 an eight-character code in the address is looked up as a code, not a token", async () => {
    client.apiFetch.mockResolvedValue(result());
    open("K7MQ-4XPR");
    await screen.findByRole("heading", { name: "Genuine prescription" });
    expect(client.apiFetch).toHaveBeenCalledWith("/verify/c/cure-dental/K7MQ-4XPR", { auth: false });
  });

  test("REG-FE-VERIFY-010 one scan is one look: rendering again does not ask again", async () => {
    client.apiFetch.mockResolvedValue(result());
    const { rerender } = open();
    await screen.findByRole("heading", { name: "Genuine prescription" });
    rerender(<div />);
    expect(client.apiFetch).toHaveBeenCalledTimes(1);
  });

  test("REG-FE-VERIFY-011 the clinic's logo is shown when it has one, and its initials when the picture fails", async () => {
    client.apiFetch.mockResolvedValue(result({ has_logo: true }));
    open();
    const img = await screen.findByRole("presentation", { hidden: true }).catch(() => null);
    const logo = (img ?? document.querySelector("img")) as HTMLImageElement;
    expect(logo.getAttribute("src")).toBe("/api/v1/verify/logo/cure-dental");
    logo.dispatchEvent(new Event("error"));
    await waitFor(() => expect(screen.getByText("CD")).toBeInTheDocument());
  });

  test("REG-FE-VERIFY-012 the reference can be copied", async () => {
    client.apiFetch.mockResolvedValue(result());
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: "Copy reference Rx 7gbzsm" }));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("Rx 7gbzsm"));
  });
});

describe("REG-FE-VERIFY the page for typing the code by hand", () => {
  test("REG-FE-VERIFY-020 it asks for the clinic and the eight-character code, refuses less, and opens the same page the QR would", async () => {
    client.apiFetch.mockReset();
    client.apiFetch.mockResolvedValue(result());
    const { user } = renderUI(
      <Routes><Route path="/v" element={<VerifyEntryPage />} /><Route path="/v/:slug/:key" element={<VerifyPage />} /></Routes>,
      { route: "/v" },
    );
    await user.click(screen.getByRole("button", { name: "Check this paper" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the clinic's name and the eight-character code");
    expect(currentLocation()).toBe("/v");

    await user.type(screen.getByLabelText(/Clinic/), "Cure Dental");
    await user.type(screen.getByLabelText(/Code/), "k7mq-4xp");
    await user.click(screen.getByRole("button", { name: "Check this paper" }));
    expect(currentLocation()).toBe("/v"); // seven characters: not yet

    await user.type(screen.getByLabelText(/Code/), "r");
    await user.click(screen.getByRole("button", { name: "Check this paper" }));
    await waitFor(() => expect(currentLocation()).toBe("/v/cure-dental/K7MQ4XPR"));
    expect(await screen.findByRole("heading", { name: "Genuine prescription" })).toBeInTheDocument();
    expect(client.apiFetch).toHaveBeenCalledWith("/verify/c/cure-dental/K7MQ4XPR", { auth: false });
  });
});
