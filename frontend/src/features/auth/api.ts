import { apiFetch } from "@/lib/api-client";

export interface UserDTO {
  id: string;
  tenant_id: string;
  email: string;
  full_name: string;
  roles: string[];
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: UserDTO;
}

export interface MfaChallenge {
  mfa_required: true;
  mfa_token: string;
}

export type LoginResponse = TokenResponse | MfaChallenge;

export function isMfaChallenge(r: LoginResponse): r is MfaChallenge {
  return (r as MfaChallenge).mfa_required === true;
}

export interface BranchRef {
  id: string;
  name: string;
  code: string;
}

export interface MeResponse {
  user: UserDTO;
  permissions: string[];
  flags: Record<string, boolean>;
  branches: BranchRef[];
  active_branch_id?: string | null;
  all_branches: boolean;
}

/** Re-issue the access token scoped to a branch ("all" = consolidated view). */
export function switchBranchApi(branchId: string) {
  return apiFetch<TokenResponse>("/auth/switch-branch", { method: "POST", body: { branch_id: branchId }, retry: false });
}

/** One of the clinic's branches this person may move to. Each branch is a workspace of its own. */
export interface Workspace { id: string; name: string; slug: string; current: boolean }

/** The clinic's branches this person may enter (empty for someone who works in one branch). */
export function listWorkspacesApi() {
  return apiFetch<Workspace[]>("/auth/workspaces");
}

/** Sign in to another branch of the clinic. The server moves the browser's session
 *  (refresh cookie) to that branch; the caller reloads the app to start clean there. */
export function switchWorkspaceApi(workspaceId: string) {
  return apiFetch<TokenResponse>("/auth/switch-workspace", { method: "POST", body: { workspace_id: workspaceId }, retry: false });
}

export function loginApi(body: { workspace: string; email: string; password: string }) {
  return apiFetch<LoginResponse>("/auth/login", { method: "POST", body, auth: false, retry: false });
}

export function verifyMfaApi(body: { mfa_token: string; code: string }) {
  return apiFetch<TokenResponse>("/auth/mfa", { method: "POST", body, auth: false, retry: false });
}

export function meApi() {
  return apiFetch<MeResponse>("/auth/me");
}

export function logoutApi() {
  return apiFetch<void>("/auth/logout", { method: "POST", auth: false, retry: false });
}

// Self-service account changes for the signed-in user. Both confirm the current
// password server-side.
export function changePasswordApi(body: { current_password: string; new_password: string }) {
  return apiFetch<void>("/auth/password", { method: "POST", body });
}
export function changeEmailApi(body: { new_email: string; current_password: string }) {
  return apiFetch<void>("/auth/email", { method: "POST", body });
}

/** Sign out of every other device, keeping the current session. Returns the count revoked. */
export function signOutOtherDevicesApi() {
  return apiFetch<{ revoked: number }>("/auth/sessions/logout-others", { method: "POST" });
}

/** One place this user is signed in. */
export interface Device {
  id: string;
  user_agent: string;
  ip: string;
  country: string;
  label: string;
  /** When this device first signed in (kept across renewals). */
  started_at: string;
  /** The latest renewal of its sign-in. */
  last_active: string;
  expires_at: string;
  current: boolean;
}
export function listSessionsApi() {
  return apiFetch<Device[]>("/auth/sessions");
}
/** Sign one OTHER device out. */
export function revokeSessionApi(id: string) {
  return apiFetch<void>(`/auth/sessions/${id}`, { method: "DELETE" });
}
/** Name a device ("" removes the name). */
export function labelSessionApi(id: string, label: string) {
  return apiFetch<void>(`/auth/sessions/${id}/label`, { method: "PUT", body: { label } });
}
