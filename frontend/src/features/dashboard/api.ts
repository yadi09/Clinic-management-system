// The home screen's single request.
//
// One call rather than six, because the page must be useful before it is finished
// loading — a dashboard that paints its tiles one at a time reads as broken even
// when every number arrives.
import { apiFetch } from "@/lib/api-client";

export interface DashMoney {
  collected_today: string;
  collected_yesterday: string;
  owed: string;
  owed_patients: number;
  oldest_days: number;
  booked_ahead: string;
  booked_visits: number;
}

export interface DashFlow {
  waiting: number;
  in_consult: number;
  seen_today: number;
  booked_today: number;
  arrived: number;
  /** Booked earlier today and still not here — a list to phone, not a statistic. */
  overdue: number;
}

export interface DashAlert {
  kind: string;
  text: string;
  amount?: string;
  count: number;
  href: string;
  tone: "danger" | "warn" | "info";
}

export interface DashToday {
  /** Absent for staff who may not see the clinic's takings. */
  money?: DashMoney;
  flow?: DashFlow;
  series?: { date: string; amount: string }[];
  attention: DashAlert[];
  clinic_name?: string;
  patients: number;
}

export function dashboardToday() {
  return apiFetch<DashToday>("/dashboard/today");
}
