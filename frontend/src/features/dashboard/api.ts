// The home screen's two requests.
//
// "Today" is everything but the money chart, so the page is useful the moment it
// arrives. The chart is its own request (and its own lazily loaded code), because a
// dashboard that waits for a chart before showing who is in the waiting room has its
// priorities backwards.
import { apiFetch } from "@/lib/api-client";

export interface DayPoint {
  date: string;
  amount: string;
  /** Payments taken that day, refunds not counted. */
  count: number;
}

export interface DashBucket {
  key: "0-30" | "31-60" | "61-90" | "90+";
  label: string;
  amount: string;
  count: number;
}

export interface DashOwer {
  patient_id: string;
  name: string;
  owed: string;
  oldest_days: number;
  why: string;
}

export interface DashMoney {
  collected_today: string;
  /** Yesterday up to this time of day, so a morning is compared with a morning. */
  collected_yesterday_by_now: string;
  collected_yesterday: string;
  last_7: string;
  prev_7: string;
  /** Fourteen days, oldest first, for the tiles' trend lines. */
  series: DayPoint[];
  /** The Finance page's Receivables total: at the cashier plus never billed. */
  owed: string;
  owed_at_cashier: string;
  owed_unbilled: string;
  owed_patients: number;
  oldest_days: number;
  /** Empty when the plan does not include debt ageing. */
  aging: DashBucket[];
  top_owers: DashOwer[];
  booked_ahead: string;
  booked_visits: number;
}

export interface DashUpcoming {
  patient_id: string;
  name: string;
  what: string;
  provider?: string;
  /** Appointments only; a treatment visit is booked for a day, not a time. */
  starts_at?: string;
  late_min?: number;
}

export interface DashFlow {
  booked: number;
  walk_ins: number;
  waiting: number;
  in_chair: number;
  done: number;
  to_come: number;
  late: number;
  longest_wait: number;
  avg_wait: number;
  avg_visit: number;
  first_arrival?: string;
  upcoming: DashUpcoming[];
}

export interface DashAlert {
  kind: string;
  text: string;
  detail?: string;
  amount?: string;
  count: number;
  href: string;
  action: string;
  patient_id?: string;
  tone: "danger" | "warn" | "info";
}

export interface DashWeekDay {
  date: string;
  visits: number;
  /** Empty for staff who may not see money. */
  amount?: string;
}

export interface DashToday {
  /** The clinic's own day and hour (Addis), not the browser's. */
  date: string;
  hour: number;
  money?: DashMoney;
  flow?: DashFlow;
  week?: DashWeekDay[];
  attention: DashAlert[];
  clinic_name?: string;
  /** Empty when the session is looking at all branches. */
  branch_name?: string;
  patients: number;
}

export interface DashLine {
  key: string;
  label: string;
  amount: string;
  count: number;
}

export interface DashTakings {
  days: number;
  total: string;
  prev: string;
  series: DayPoint[];
  by_source: DashLine[];
  by_method: DashLine[];
}

export const dashKeys = {
  today: ["dashboard-today"] as const,
  takings: (days: number) => ["dashboard-takings", days] as const,
};

export function dashboardToday() {
  return apiFetch<DashToday>("/dashboard/today");
}

export function dashboardTakings(days: number) {
  return apiFetch<DashTakings | null>(`/dashboard/takings?days=${days}`);
}
