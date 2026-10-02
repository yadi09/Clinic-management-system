// Where each thing on the dashboard opens — or nothing, when the person cannot open it.
//
// A number you can see but not open is fine; a link that lands on "you do not have
// access" is a small betrayal every time, and the cashier would meet one on the
// Finance tile every morning. So every link is built here, against the same rules the
// navigation uses (app/nav.ts), and comes back undefined when it would not work.
import { useAuth } from "@/app/auth-context";

export type Href = string | undefined;

export function useDashLinks() {
  const { can, flagOn } = useAuth();
  const dental = flagOn("dental");
  const finance = can("billing.manage") && flagOn("finance_advanced");
  const ageing = finance && flagOn("debt_ageing");
  const patients = can("patient.read") || can("patient.search");

  return {
    dental,
    /** A patient's page. `money` opens a dental record on its Money panel. */
    patient: (id: string, opts?: { money?: boolean }): Href =>
      !patients || !id ? undefined : `/patients/${id}${opts?.money && dental ? "?panel=money" : ""}`,
    /** The queue page for this kind of clinic. */
    queue: (): Href =>
      dental ? (can("dental.manage") ? "/chairside" : can("queue.manage") ? "/reception" : undefined)
        : can("queue.manage") ? "/reception" : can("encounter.manage") ? "/worklist" : undefined,
    chair: (): Href =>
      dental ? (can("dental.manage") ? "/chairside" : undefined) : can("encounter.manage") ? "/worklist" : undefined,
    reception: (): Href => (can("queue.manage") ? "/reception" : undefined),
    appointments: (opts?: { date?: string; view?: "followups" }): Href => {
      if (!can("appointment.manage")) return undefined;
      const q = new URLSearchParams();
      if (opts?.date) q.set("date", opts.date);
      if (opts?.view) q.set("view", opts.view);
      return `/appointments${q.toString() ? `?${q}` : ""}`;
    },
    /** Finance, for a period key ("today", "7d", "30d", "90d") or a single ISO day. */
    finance: (period?: string, tab?: string): Href => {
      if (!finance) return undefined;
      const q = new URLSearchParams();
      if (tab) q.set("tab", tab);
      if (period) q.set("period", period);
      return `/finance${q.toString() ? `?${q}` : ""}`;
    },
    receivables: (bucket?: string): Href =>
      !ageing ? undefined : `/finance?tab=receivables${bucket ? `&bucket=${encodeURIComponent(bucket)}` : ""}`,
    cashier: (): Href => (can("payment.collect") ? "/cashier" : undefined),
    unbilled: (): Href =>
      dental && (can("payment.charge") || can("payment.collect") || can("dental.manage")) ? "/dental/unbilled" : undefined,
    /**
     * An alert's own link, checked like any other. The server names the page; the
     * client knows whether this person may open it.
     */
    alert: (href: string): Href => {
      if (href.startsWith("/finance")) {
        if (href.includes("tab=receivables")) return ageing ? href : finance ? "/finance" : undefined;
        return finance ? href : undefined;
      }
      if (href.startsWith("/dental/unbilled")) return dental ? href : undefined;
      if (href.startsWith("/appointments")) return can("appointment.manage") ? href : undefined;
      if (href.startsWith("/chairside")) return can("dental.manage") ? href : can("queue.manage") ? "/reception" : undefined;
      if (href.startsWith("/reception")) return can("queue.manage") ? href : undefined;
      return href;
    },
  };
}

export type DashLinks = ReturnType<typeof useDashLinks>;
