// The registration fee rule in words (FEAT-REG-1). Settings describes the rule with
// these sentences and the reception desk explains a patient's fee with them, so the
// two can never say different things about the same rule.
import { formatEthiopian } from "@/lib/ethiopian";
import type { RegistrationPolicy, RegistrationStatus, RegistrationUnit } from "@/features/billing/api";

const UNIT: Record<RegistrationUnit, [string, string]> = {
  day: ["day", "days"],
  week: ["week", "weeks"],
  month: ["month", "months"],
};

/** "30 days", "1 week", "2 months". */
export function period(count: number, unit: RegistrationUnit): string {
  const [one, many] = UNIT[unit];
  return `${count} ${count === 1 ? one : many}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Sep 2026 (Meskerem 2, 2019 EC)": the date as the desk and the patient both read it. */
export function regDate(iso: string): string {
  // Spelled out here, not by the browser: some write "Sept", some "Sep", and the desk
  // and this text must read the same on every phone.
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y} (${formatEthiopian(iso)} EC)`;
}

/** The rule as a sentence for Settings: what a new patient pays, and when again. */
export function describeRule(p: RegistrationPolicy, feeName: string): string {
  switch (p.rule) {
    case "once":
      return `A new patient pays ${feeName} once. They never pay it again.`;
    case "every":
      return p.every_count && p.every_unit
        ? `A new patient pays ${feeName}. They pay it again ${period(p.every_count, p.every_unit)} after they last paid it.`
        : `Choose how long ${feeName} lasts.`;
    default:
      return `Every patient pays ${feeName} on every visit.`;
  }
}

/** Why this arrival does or does not charge registration, for the desk to read aloud. */
export function statusLine(s: RegistrationStatus): string {
  switch (s.reason) {
    case "registered":
      if (s.rule === "once") return `Registered ${regDate(s.registered_on!)}. One time only.`;
      return `Registered ${regDate(s.registered_on!)}, valid until ${regDate(s.valid_until!)}.`;
    case "paper":
      if (s.rule === "once") return "Registered on the paper register before ClinicOS.";
      return `On the paper register; counted from ${regDate(s.registered_on!)}, valid until ${regDate(s.valid_until!)}.`;
    case "owed":
      return `Registration from ${regDate(s.registered_on!)} is still unpaid. Collect that one; no new fee.`;
    case "expired":
      return `Registration ran out on ${regDate(s.valid_until!)}. Paying again today.`;
    case "never_registered":
      return "New patient: first registration.";
    default:
      return "";
  }
}
