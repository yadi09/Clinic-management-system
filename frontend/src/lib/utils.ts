import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class names with conflict resolution (ShadCN convention). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Whole years from a "YYYY-MM-DD" birthdate; null if unparseable or in the future. */
export function ageYears(dob?: string | null): number | null {
  if (!dob) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob);
  if (!m) return null;
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let y = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) y--;
  return y >= 0 && y < 200 ? y : null;
}

/**
 * Human age for display: "34 yrs", "1 yr", or months/days for infants — the
 * granularity clinicians actually need at the top of a chart.
 */
export function ageLabel(dob?: string | null): string {
  const y = ageYears(dob);
  if (y === null) return "—";
  if (y >= 1) return `${y} ${y === 1 ? "yr" : "yrs"}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dob!)!;
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.floor((Date.now() - b.getTime()) / 86400000);
  if (days >= 30) {
    const months = Math.floor(days / 30.44);
    return `${months} ${months === 1 ? "mo" : "mos"}`;
  }
  return `${Math.max(days, 0)} ${days === 1 ? "day" : "days"}`;
}
