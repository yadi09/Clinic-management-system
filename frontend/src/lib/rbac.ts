// Client-side RBAC + feature-flag helpers. These gate UI affordances only — the
// backend re-checks role/scope/flag on every request (NFR-13). Never rely on
// these for security.

export function can(permissions: string[] | undefined, code: string): boolean {
  return !!permissions?.includes(code);
}

export function hasRole(roles: string[] | undefined, code: string): boolean {
  return !!roles?.includes(code);
}

export function hasAnyRole(roles: string[] | undefined, codes: string[]): boolean {
  return !!roles?.some((r) => codes.includes(r));
}

export function isFlagOn(flags: Record<string, boolean> | undefined, flag: string): boolean {
  return !!flags?.[flag];
}
