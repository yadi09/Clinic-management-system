import { apiFetch } from "@/lib/api-client";

export type DatingMethod = "LMP" | "ULTRASOUND" | "KNOWN_EDD" | "IVF" | "CONCEPTION";

export interface DatingInputs {
  firstDayOfLmp?: string;
  cycleLength?: number;
  ultrasoundDate?: string;
  gaWeeks?: number;
  gaDays?: number;
  edd?: string;
  transferDate?: string;
  embryoType?: "day3" | "day5" | "day6";
  conceptionDate?: string;
}

export interface DatingWindow {
  start?: string;
  end?: string;
  point?: string;
}

export interface DatingResult {
  calculatedLmp: string;
  edd: string;
  estimatedConception: string;
  gestationalAge: { days: number; weeks: number; remDays: number; label: string; valid: boolean };
  windows: Record<string, DatingWindow>;
  method?: DatingMethod;
  updatedAt?: string;
}

export interface Redate {
  recommended: boolean;
  discrepancyDays: number;
  previousEdd: string;
  newEdd: string;
}

export interface DatingHistoryEntry {
  method: DatingMethod;
  calculatedLmp: string;
  edd: string;
  recordedByName?: string;
  recordedAt: string;
  note?: string;
}

interface DatingBody {
  method: DatingMethod;
  inputs: DatingInputs;
  gaDate?: string;
  note?: string;
}

export function previewDating(body: DatingBody) {
  return apiFetch<DatingResult>("/dating/preview", { method: "POST", body });
}
export function saveDating(patientId: string, body: DatingBody) {
  return apiFetch<{ dating: DatingResult; redate?: Redate | null }>(`/patients/${patientId}/dating`, { method: "POST", body });
}
export function getDating(patientId: string) {
  return apiFetch<{ dating: DatingResult | null }>(`/patients/${patientId}/dating`);
}
/** Which of these patients already has a dating — one request for a whole worklist,
 *  so a board can mark the rows instead of asking per patient on every refresh. */
export interface DatingSummary extends DatingResult { patientId: string }
export function datingSummary(patientIds: string[]) {
  if (patientIds.length === 0) return Promise.resolve({ items: [] as DatingSummary[] });
  return apiFetch<{ items: DatingSummary[] }>(`/dating/summary?patients=${patientIds.join(",")}`);
}
export function getDatingHistory(patientId: string) {
  return apiFetch<{ entries: DatingHistoryEntry[] }>(`/patients/${patientId}/dating/history`);
}
