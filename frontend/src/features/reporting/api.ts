import { apiFetch } from "@/lib/api-client";

export interface Dhis2Column {
  key: string;
  sex: "M" | "F";
  label: string;
}
export interface Dhis2Disease {
  rank: number;
  name: string;
  data_element: string;
  counts: Record<string, number>;
  total: number;
}
export interface Dhis2Report {
  configured: boolean;
  context: {
    org_unit: string;
    /** False until the clinic has chosen its own facility in DHIS2. */
    org_unit_linked: boolean;
    data_set: string;
    period: string;
    period_label: string;
    /** The Gregorian days the Ethiopian month covers (YYYY-MM-DD). */
    period_start: string;
    period_end: string;
    department: string;
    outcome: string;
  };
  columns: Dhis2Column[];
  diseases: Dhis2Disease[];
  column_totals: Record<string, number>;
  grand_total: number;
}
export interface Dhis2ImportSummary {
  status: string;
  description: string;
  imported: number;
  updated: number;
  ignored: number;
  deleted: number;
  conflicts: string[];
}
export interface Dhis2Submitted {
  count: number;
  values: { data_element: string; category_option_combo: string; value: string }[];
}

export interface Dhis2Config {
  connected: boolean;
  base_url: string;
  org_unit: string;
  org_unit_name: string;
  data_set: string;
  period_calendar: "ethiopian" | "gregorian";
}
export interface Dhis2Facility {
  id: string;
  name: string;
}
export interface Dhis2Element {
  id: string;
  name: string;
}
export interface Dhis2MapEntry {
  disease_key: string;
  disease_name: string;
  data_element: string;
  data_element_name: string;
}

export function getDhis2Report() {
  return apiFetch<Dhis2Report>("/reporting/dhis2");
}
export function getDhis2Config() {
  return apiFetch<Dhis2Config>("/reporting/dhis2/config");
}
export function saveDhis2Config(body: {
  token?: string;
  base_url?: string;
  org_unit?: string;
  org_unit_name?: string;
  period_calendar?: string;
}) {
  return apiFetch<Dhis2Config>("/reporting/dhis2/config", { method: "PUT", body });
}
export function testDhis2(token: string, baseUrl?: string) {
  return apiFetch<{ facilities: Dhis2Facility[]; calendar: string }>("/reporting/dhis2/test", {
    method: "POST",
    body: { token, base_url: baseUrl },
  });
}
export function listDhis2Elements() {
  return apiFetch<{ elements: Dhis2Element[] }>("/reporting/dhis2/elements");
}
export function getDhis2Mapping() {
  return apiFetch<{ entries: Dhis2MapEntry[] }>("/reporting/dhis2/mapping");
}
export function saveDhis2Mapping(entries: Dhis2MapEntry[]) {
  return apiFetch<void>("/reporting/dhis2/mapping", { method: "PUT", body: { entries } });
}
export function pushDhis2() {
  return apiFetch<Dhis2ImportSummary>("/reporting/dhis2/push", { method: "POST" });
}
export function getDhis2Submitted() {
  return apiFetch<Dhis2Submitted>("/reporting/dhis2/submitted");
}
export function clearDhis2() {
  return apiFetch<Dhis2ImportSummary>("/reporting/dhis2/clear", { method: "POST" });
}
