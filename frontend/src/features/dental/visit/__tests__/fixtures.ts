// Minimal Plan/Session builders for the visit-card tests. Only the fields the pure
// helpers read are meaningful; the rest are filled so the shapes type-check loosely.
import type { Plan, Session } from "@/features/dental/api";

export const S = (id: string, date: string, seq: number, status = "planned", extra: Partial<Session> = {}): Session =>
  ({ id, seq, scheduled_date: date, amount_due: "2000", status, payment: "unpaid", images: [], prescriptions: [],
     pay_later: false, ...extra }) as unknown as Session;

export const P = (id: string, title: string, sessions: Session[], status = "active", extra: Partial<Plan> = {}): Plan =>
  ({ id, title, total_amount: "12000", start_date: "2026-01-01", interval_unit: "month", interval_count: 1,
     session_count: sessions.length, status, created_at: "", sessions,
     money: { planned: "0", collected: "0", at_cashier: "0" }, ...extra }) as unknown as Plan;
