// The one clinic this browser signs in to. Stored after a sign-in proves the code
// right (so a typo is never remembered), cleared by "Change". Only the code: never
// an email or a password. Storage can be blocked (private mode, policy): then the
// page simply asks for the code every time.
const KEY = "clinicos.login.clinic";

export const rememberedClinic = {
  get(): string | null {
    try {
      return localStorage.getItem(KEY) || null;
    } catch {
      return null;
    }
  },
  set(code: string) {
    try {
      localStorage.setItem(KEY, code);
    } catch {
      /* not remembered: asked again next time */
    }
  },
  clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing stored */
    }
  },
};

/** A clinic code as the server keeps it: lower case, spaces become dashes. */
export function normalizeClinicCode(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}
