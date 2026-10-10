// What the print engine knows about this clinic, readable from anywhere.
//
// A print button is a plain function call deep inside a screen; it cannot reach for a
// React hook. The provider (mounted once, signed in) keeps this up to date from the
// settings query, and the engine reads it when a paper is requested.
import type { PrintCtx } from "@/features/printing/blocks";
import { DEFAULT_SETTINGS } from "@/features/printing/settings";

let current: PrintCtx = { settings: DEFAULT_SETTINGS, logo: "", clinicName: "", branch: null };

export const getPrintContext = (): PrintCtx => current;
export function setPrintContext(c: PrintCtx) { current = c; }
