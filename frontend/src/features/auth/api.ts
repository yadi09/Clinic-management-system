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

export interface MeResponse {
  user: UserDTO;
  permissions: string[];
  flags: Record<string, boolean>;
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
