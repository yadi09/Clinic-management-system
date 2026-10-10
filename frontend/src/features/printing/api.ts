import { apiFetch } from "@/lib/api-client";

export interface StoredPrintSettings {
  /** The settings document; its shape is owned by settings.ts. */
  settings: unknown;
  /** The logo as a data URL, or "". */
  logo: string;
}
export const getPrintSettings = () => apiFetch<StoredPrintSettings>("/org/print-settings");
/** `logo`: omit to keep the stored one, "" to remove it, a data URL to replace it. */
export const savePrintSettings = (body: { settings: unknown; logo?: string }) =>
  apiFetch<StoredPrintSettings>("/org/print-settings", { method: "PUT", body });

export interface PrintMark {
  count: number;
  first_at?: string;
  first_by?: string;
  last_at?: string;
  last_by?: string;
}
/** How many times a paper has been printed — without counting this look. */
export const peekPrint = (kind: string, ref: string) =>
  apiFetch<PrintMark>(`/org/print-log?kind=${encodeURIComponent(kind)}&ref=${encodeURIComponent(ref)}`);
/** Record that a paper is being printed now. */
export const logPrint = (kind: string, ref: string) =>
  apiFetch<PrintMark>("/org/print-log", { method: "POST", body: { kind, ref } });
