// The public check of a printed paper. No account, no token: whoever holds the paper
// opens its link. Never cached by the server, because a paper valid a minute ago may
// be cancelled now — and every look is counted.
import { apiFetch } from "@/lib/api-client";

export type CheckStatus = "genuine" | "cancelled" | "superseded" | "expired";

export interface CheckResult {
  status: CheckStatus;
  kind: "dental_rx" | "encounter_rx";
  ref: string;
  clinic: string;
  branch?: string;
  slug: string;
  has_logo: boolean;
  /** The day the prescription was written, YYYY-MM-DD in the clinic's calendar. */
  written_at: string;
  days_ago: number;
  valid_until?: string;
  patient?: { name: string; age: number; gender?: string };
  prescriber?: string;
  medicines?: { name: string; dose?: string; frequency?: string; duration?: string; instructions?: string }[];
  note?: string;
  dispensed_at?: string;
  checks: { before: number; first_at?: string; last_at?: string };
}

/** A token is 26 characters; the short code under the QR is 8 (4-4 with a dash). */
export const isToken = (key: string) => /^[a-z2-7]{26}$/i.test(key);

export function checkPaper(slug: string, key: string) {
  const path = isToken(key)
    ? `/verify/t/${encodeURIComponent(slug)}/${encodeURIComponent(key.toLowerCase())}`
    : `/verify/c/${encodeURIComponent(slug)}/${encodeURIComponent(key)}`;
  return apiFetch<CheckResult>(path, { auth: false });
}

/** Where the clinic's logo is served for the page, when it has one. */
export const logoUrl = (slug: string) => `/api/v1/verify/logo/${encodeURIComponent(slug)}`;
