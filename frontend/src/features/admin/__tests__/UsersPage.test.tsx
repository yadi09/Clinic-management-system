// Staff: who works here, what they may do, and how they get back in when they forget
// a password. A dental clinic is offered dental roles; the owner cannot remove
// themself; every failed change says so.
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Whole-page flows with many clicks; the shared 5s budget is too tight when the full
// suite runs in parallel (and under scripts/test/time-sweep.sh).
vi.setConfig({ testTimeout: 60_000 });

vi.mock("@/app/auth-context", async () => (await import("@/test/admin")).authModule);
vi.mock("@/components/ui/sonner", async (orig) => ({ ...(await orig<object>()), toast: (await import("@/test/admin")).toastSpy }));
const api = vi.hoisted(() => ({
  listUsers: vi.fn(), listRoles: vi.fn(), inviteUser: vi.fn(), updateUserStatus: vi.fn(), updateUserProfile: vi.fn(),
  deleteUser: vi.fn(), assignRoles: vi.fn(), issueResetLink: vi.fn(),
}));
vi.mock("@/features/admin/api", async (orig) => ({ ...(await orig<object>()), ...api }));

import { UsersPage } from "@/features/admin/pages/UsersPage";
import { roleOffered } from "@/features/admin/roles";
import type { UserListItem } from "@/features/admin/api";
import { AppError } from "@/lib/api-client";
import { deferred, OWNER_USER, resetToasts, setAuth, toastSpy } from "@/test/admin";
import { renderUI } from "@/test/render";

const u = (over: Partial<UserListItem>): UserListItem => ({
  id: "usr_x", email: "x@cure.et", full_name: "X", phone: "", status: "active", roles: ["receptionist"], created_at: "2026-01-01", ...over,
});
const OWNER_ROW = u({ id: OWNER_USER.id, email: OWNER_USER.email, full_name: "Hanna Desta", roles: ["clinic_admin"], phone: "0911223344" });
const DENTIST = u({ id: "usr_d", email: "dr@cure.et", full_name: "Dr Selam", roles: ["dentist"], phone: "0911000000" });
const RECEPTION = u({ id: "usr_r", email: "desk@cure.et", full_name: "Meron Desk", roles: ["receptionist", "cashier"] });
const SUSPENDED = u({ id: "usr_s", email: "old@cure.et", full_name: "Old Staff", status: "suspended", roles: [] });
const INVITED = u({ id: "usr_i", email: "new@cure.et", full_name: "New Hire", status: "invited", phone: "+251 911 555 666" });
const ROLES = ["clinic_admin", "dentist", "receptionist", "cashier", "nurse", "pharmacist", "lab_technician"].map((code) => ({
  id: `role_${code}`, code, name: code.replace(/_/g, " "), is_system: true,
}));

const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });
const page = () => renderUI(<UsersPage />);

beforeEach(() => {
  setAuth();
  resetToasts();
  api.listUsers.mockResolvedValue([OWNER_ROW, DENTIST, RECEPTION, SUSPENDED, INVITED]);
  api.listRoles.mockResolvedValue(ROLES);
  for (const f of [api.updateUserStatus, api.updateUserProfile, api.deleteUser, api.assignRoles]) f.mockResolvedValue(undefined);
});

describe("REG-FE-STAFF staff list", () => {
  test("REG-FE-STAFF-001 the list: names, phones written the way staff read them, roles and status", async () => {
    page();
    expect(await screen.findByText("Dr Selam")).toBeInTheDocument();
    expect(screen.getByText("5 members")).toBeInTheDocument();
    expect(within(row("Dr Selam")).getByRole("link", { name: "0911 00 00 00" })).toHaveAttribute("href", "tel:0911000000");
    expect(within(row("Meron Desk")).getByText("receptionist, cashier")).toBeInTheDocument();
    expect(within(row("Old Staff")).getByText("—")).toBeInTheDocument();
    expect(within(row("New Hire")).getByText("+251 911 555 666")).toBeInTheDocument();
    expect(within(row("New Hire")).getByText("invited")).toBeInTheDocument();
  });

  test("REG-FE-STAFF-002 while loading, placeholders; with only read access, no actions at all", async () => {
    api.listUsers.mockReturnValueOnce(new Promise(() => {}));
    const r = page();
    expect(screen.getByText("0 members")).toBeInTheDocument();
    expect(r.container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    r.unmount();
    setAuth({ perms: ["user.read"] });
    page();
    await screen.findByText("Dr Selam");
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Invite user/ })).not.toBeInTheDocument();
    expect(within(row("Meron Desk")).getByText("—")).toBeInTheDocument(); // no phone, no "Add"
  });

  test("REG-FE-STAFF-003 suspend an active member and reactivate a suspended one", async () => {
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(api.updateUserStatus).toHaveBeenCalledWith("usr_d", "suspended"));
    expect(toastSpy.success).toHaveBeenCalledWith("Staff updated");
    await user.click(within(row("Old Staff")).getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(api.updateUserStatus).toHaveBeenCalledWith("usr_s", "active"));
    // A suspended member gets no reset link.
    expect(within(row("Old Staff")).queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
  });

  test("REG-FE-STAFF-008 a deactivated member gets no reset link either (SEC-2: the server refuses it)", async () => {
    api.listUsers.mockResolvedValue([OWNER_ROW, u({ id: "usr_x", email: "gone@cure.et", full_name: "Gone Staff", status: "deactivated", roles: [] }), INVITED]);
    page();
    await screen.findByText("Gone Staff");
    expect(within(row("Gone Staff")).queryByRole("button", { name: "Reset password" })).not.toBeInTheDocument();
    // An invited person who never joined can still be sent a fresh link.
    expect(within(row("New Hire")).getByRole("button", { name: "Reset password" })).toBeInTheDocument();
  });

  // NEW-AUTH-1. The Delete button is hidden on your own row, but Suspend is not: the
  // only owner of a clinic can suspend themself and be locked out of every page,
  // with nobody left who can reactivate them.
  test.fails("REG-FE-STAFF-004 KNOWN BUG NEW-AUTH-1 you cannot suspend yourself", async () => {
    page();
    await screen.findByText("Dr Selam");
    expect(within(row("Hanna Desta")).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(within(row("Hanna Desta")).queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();
  });

  // FE-7. Suspend / Reactivate has no onError: a refused change (last admin, server
  // down) leaves the row as it was and says nothing, so the owner believes it worked.
  test.fails("REG-FE-STAFF-005 KNOWN BUG FE-7 a refused suspend is reported", async () => {
    api.updateUserStatus.mockRejectedValue(new AppError(409, "LAST_ADMIN", "The clinic needs at least one administrator."));
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(api.updateUserStatus).toHaveBeenCalled());
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalled(), { timeout: 500 });
  });

  test("REG-FE-STAFF-006 delete asks first, names the person, and removes them", async () => {
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Delete" }));
    const dlg = screen.getByRole("dialog", { name: "Remove staff member" });
    expect(dlg).toHaveTextContent("Remove Dr Selam (dr@cure.et)?");
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(api.deleteUser).not.toHaveBeenCalled();
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteUser).toHaveBeenCalledWith("usr_d"));
    expect(toastSpy.success).toHaveBeenCalledWith("Staff member removed");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-STAFF-007 a refused delete is reported and the dialog stays", async () => {
    api.deleteUser.mockRejectedValueOnce(new Error("Has signed records"));
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Has signed records"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    api.deleteUser.mockRejectedValueOnce("odd");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not remove the staff member"));
  });
});

describe("REG-FE-STAFF password reset link", () => {
  test("REG-FE-STAFF-010 a reset link is shown once, with the phone to check identity, and copies", async () => {
    api.issueResetLink.mockResolvedValue({ id: "usr_d", email: "dr@cure.et", invite_link: "https://app/accept-invite?token=r1" });
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Reset password" }));
    const dlg = await screen.findByRole("dialog", { name: "Password reset link" });
    expect(dlg).toHaveTextContent("Give this to Dr Selam (dr@cure.et)");
    expect(within(dlg).getByRole("link", { name: "0911 00 00 00" })).toBeInTheDocument();
    expect(within(dlg).getByDisplayValue("https://app/accept-invite?token=r1")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Copy link" }));
    // user-event installs its own clipboard; what was written is what can be read back.
    expect(await navigator.clipboard.readText()).toBe("https://app/accept-invite?token=r1");
    expect(toastSpy.success).toHaveBeenCalledWith("Link copied");
    await user.click(within(dlg).getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-STAFF-011 no phone on record: hand it over in person; while issuing, the row says Working…", async () => {
    const d = deferred<{ id: string; email: string; invite_link: string }>();
    api.issueResetLink.mockReturnValueOnce(d.promise);
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Meron Desk")).getByRole("button", { name: "Reset password" }));
    expect(within(row("Meron Desk")).getByRole("button", { name: "Working…" })).toBeInTheDocument();
    d.resolve({ id: "usr_r", email: "desk@cure.et", invite_link: "L" });
    expect(await screen.findByText(/No phone on their record/)).toBeInTheDocument();
  });

  test("REG-FE-STAFF-012 a refused reset link is reported", async () => {
    api.issueResetLink.mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "Only an owner can do that"));
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Only an owner can do that"));
    api.issueResetLink.mockRejectedValueOnce(new Error("x"));
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not create a reset link"));
  });
});

describe("REG-FE-STAFF edit details", () => {
  test("REG-FE-STAFF-020 edit name and phone: warns on a short number, notes Safaricom and landlines, saves trimmed", async () => {
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Edit details" }));
    const dlg = screen.getByRole("dialog", { name: /Edit details — dr@cure.et/ });
    const [name, phone] = within(dlg).getAllByRole("textbox");
    const save = within(dlg).getByRole("button", { name: "Save" });
    expect(save).toBeDisabled(); // nothing changed yet
    await user.clear(phone);
    await user.type(phone, "0911");
    expect(within(dlg).getByText("That looks too short for a phone number.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(phone);
    await user.type(phone, "0712345678");
    expect(within(dlg).getByText(/Safaricom numbers can be called/)).toBeInTheDocument();
    await user.clear(phone);
    await user.type(phone, "0116123456");
    expect(within(dlg).getByText(/looks like a landline/)).toBeInTheDocument();
    await user.clear(phone);
    await user.type(phone, "+251 911 22 33 44");
    expect(within(dlg).getByText(/How the clinic reaches this person/)).toBeInTheDocument();
    await user.clear(name);
    expect(save).toBeDisabled();
    await user.type(name, "  Dr Selam Bekele  {Enter}");
    await waitFor(() => expect(api.updateUserProfile).toHaveBeenCalledWith("usr_d", "Dr Selam Bekele", "+251 911 22 33 44"));
    expect(toastSpy.success).toHaveBeenCalledWith("Staff details updated");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-STAFF-021 'Add' on a missing phone opens the same editor; a refusal is reported; cancel closes", async () => {
    api.updateUserProfile.mockRejectedValueOnce(new AppError(422, "VALIDATION", "Phone is not valid"));
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Meron Desk")).getByRole("button", { name: "Add" }));
    const dlg = screen.getByRole("dialog");
    await user.type(within(dlg).getAllByRole("textbox")[1], "0922334455");
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Phone is not valid"));
    api.updateUserProfile.mockRejectedValueOnce(new Error("x"));
    await user.type(within(dlg).getAllByRole("textbox")[1], "{Enter}");
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not save the changes"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // Reopening the same person seeds from the record again.
    await user.click(within(row("Meron Desk")).getByRole("button", { name: "Edit details" }));
    expect(within(screen.getByRole("dialog")).getAllByRole("textbox")[1]).toHaveValue("");
    await user.keyboard("{Escape}");
  });
});

describe("REG-FE-STAFF roles", () => {
  test("REG-FE-STAFF-030 a dental clinic is offered no nurse, pharmacist or lab roles", async () => {
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Edit roles" }));
    const dlg = screen.getByRole("dialog", { name: "Edit roles — Dr Selam" });
    await within(dlg).findByRole("button", { name: "dentist" });
    const offered = within(dlg).getAllByRole("button").map((b) => b.textContent).filter((t) => ROLES.some((r) => r.name === t));
    expect(offered).toEqual(["clinic admin", "dentist", "receptionist", "cashier"]);
  });

  test("REG-FE-STAFF-031 toggle roles, choose branches, and save; none selected cannot be saved", async () => {
    setAuth({ branches: [{ id: "br_1", name: "Bole", code: "B" }, { id: "br_2", name: "Piassa", code: "P" }] });
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(within(row("Dr Selam")).getByRole("button", { name: "Edit roles" }));
    const dlg = screen.getByRole("dialog");
    await user.click(await within(dlg).findByRole("button", { name: "dentist" }));
    expect(within(dlg).getByRole("button", { name: "Save roles" })).toBeDisabled();
    await user.click(within(dlg).getByRole("button", { name: "cashier" }));
    await user.click(within(dlg).getByRole("button", { name: "Piassa" }));
    await user.click(within(dlg).getByRole("button", { name: "Bole" }));
    await user.click(within(dlg).getByRole("button", { name: "Bole" }));
    await user.click(within(dlg).getByRole("button", { name: "Save roles" }));
    await waitFor(() => expect(api.assignRoles).toHaveBeenCalledWith("usr_d", ["cashier"], ["br_2"]));
    expect(toastSpy.success).toHaveBeenCalledWith("Roles updated");
  });

  test("REG-FE-STAFF-032 a role someone already holds is shown so it can be removed; refusal reported", async () => {
    api.listUsers.mockResolvedValue([u({ id: "usr_n", full_name: "Nurse Old", roles: ["nurse"] })]);
    api.assignRoles.mockRejectedValueOnce(new AppError(403, "FORBIDDEN", "Cannot grant that"));
    const { user } = page();
    await screen.findByText("Nurse Old");
    await user.click(screen.getByRole("button", { name: "Edit roles" }));
    const dlg = screen.getByRole("dialog");
    expect(await within(dlg).findByRole("button", { name: "nurse" })).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Save roles" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Cannot grant that"));
    api.assignRoles.mockRejectedValueOnce(new Error("x"));
    await user.click(within(dlg).getByRole("button", { name: "Save roles" }));
    await waitFor(() => expect(toastSpy.error).toHaveBeenCalledWith("Could not update roles"));
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-STAFF-033 roleOffered: by module, and always when held", () => {
    const on = (flags: string[]) => (f: string) => flags.includes(f);
    expect(roleOffered("nurse", on([]))).toBe(true);
    expect(roleOffered("nurse", on(["dental"]))).toBe(false);
    expect(roleOffered("nurse", on(["dental"]), true)).toBe(true);
    expect(roleOffered("pharmacist", on(["pharmacy"]))).toBe(true);
    expect(roleOffered("lab_manager", on([]))).toBe(false);
    expect(roleOffered("dentist", on([]))).toBe(true);
  });
});

describe("REG-FE-STAFF invite", () => {
  test("REG-FE-STAFF-040 invite: email + name required, bad phone blocks, then a one-time link to share", async () => {
    setAuth({ branches: [{ id: "br_1", name: "Bole", code: "B" }, { id: "br_2", name: "Piassa", code: "P" }], activeBranchId: "br_2" });
    api.inviteUser.mockResolvedValue({ id: "usr_new", email: "abebe@cure.et", invite_link: "https://app/accept-invite?token=i1" });
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(screen.getByRole("button", { name: /Invite user/ }));
    const dlg = screen.getByRole("dialog", { name: "Invite staff" });
    const send = within(dlg).getByRole("button", { name: "Send invite" });
    expect(send).toBeDisabled();
    const [email, name, phone] = within(dlg).getAllByRole("textbox");
    await user.type(email, "abebe@cure.et");
    await user.type(name, "Abebe Kebede");
    await user.type(phone, "123");
    expect(within(dlg).getByText("That looks too short for a phone number.")).toBeInTheDocument();
    expect(send).toBeDisabled();
    await user.clear(phone);
    await user.type(phone, "0712345678");
    expect(within(dlg).getByText(/Safaricom/)).toBeInTheDocument();
    await user.clear(phone);
    await user.type(phone, " 0911223344 ");
    expect(within(dlg).getByText("How the clinic reaches this person off email.")).toBeInTheDocument();
    // No nurse in a dental clinic.
    await within(dlg).findByRole("button", { name: "dentist" });
    expect(within(dlg).queryByRole("button", { name: "nurse" })).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "dentist" }));
    await user.click(within(dlg).getByRole("button", { name: "receptionist" }));
    await user.click(within(dlg).getByRole("button", { name: "receptionist" }));
    // Defaults to the branch the admin is working in.
    await user.click(within(dlg).getByRole("button", { name: "Bole" }));
    await user.click(send);
    await waitFor(() => expect(api.inviteUser).toHaveBeenCalledWith({
      email: "abebe@cure.et", full_name: "Abebe Kebede", phone: "0911223344", roles: ["dentist"], branch_ids: ["br_2", "br_1"],
    }));
    expect(await within(dlg).findByDisplayValue("https://app/accept-invite?token=i1")).toBeInTheDocument();
    expect(dlg).toHaveTextContent("Invitation created for abebe@cure.et");
    await user.click(within(dlg).getAllByRole("button").find((b) => !b.textContent)!);
    expect(await navigator.clipboard.readText()).toBe("https://app/accept-invite?token=i1");
    await user.click(within(dlg).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  test("REG-FE-STAFF-041 a refused invite shows the reason inside the form; cancel closes it", async () => {
    api.inviteUser.mockRejectedValueOnce(new AppError(409, "EMAIL_TAKEN", "That email is already on the staff list."));
    const { user } = page();
    await screen.findByText("Dr Selam");
    await user.click(screen.getByRole("button", { name: /Invite user/ }));
    const dlg = screen.getByRole("dialog");
    const [email, name] = within(dlg).getAllByRole("textbox");
    await user.type(email, "dr@cure.et");
    await user.type(name, "Dup");
    await user.click(within(dlg).getByRole("button", { name: "Send invite" }));
    expect(await within(dlg).findByText("That email is already on the staff list.")).toBeInTheDocument();
    api.inviteUser.mockRejectedValueOnce(new Error("x"));
    await user.click(within(dlg).getByRole("button", { name: "Send invite" }));
    expect(await within(dlg).findByText("Could not invite user.")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
