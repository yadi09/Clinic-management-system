// Asking the server for a paper's check while it is being printed.
import { apiFetch } from "@/lib/api-client";

export interface IssuedCheck {
  token: string;
  slug: string;
  /** Where the QR opens, relative to the site: /v/<clinic>/<token>. */
  path: string;
  /** The short code printed under the QR, for typing when a camera will not read it. */
  code: string;
  /** The reference printed on the paper, so the paper and its page agree. */
  ref: string;
}

export const issueCheck = (kind: "dental_rx" | "encounter_rx", id: string) =>
  apiFetch<IssuedCheck>("/verify/issue", { method: "POST", body: { kind, id } });
