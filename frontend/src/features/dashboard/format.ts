// Money and time, in the words the dashboard uses.
export const num = (s?: string | number) => Number(s || 0) || 0;

/** "4,300" — whole birr; the cents are noise on a dashboard. */
export const birr = (v?: string | number) =>
  Math.round(num(v)).toLocaleString(undefined, { maximumFractionDigits: 0 });

export const etb = (v?: string | number) => `${birr(v)} ETB`;

/** "Tue 6 Oct" */
export const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "6 Oct" */
export const dayMonth = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export const weekday = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" });

/** "8:42", always in the clinic's time: a laptop set to another zone must not move
 *  the first patient of the day to 3 in the morning. */
export const clock = (rfc: string) =>
  new Date(rfc).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "Africa/Addis_Ababa" });

/** "24 min", "4 h 43 min". */
export const minutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`);

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Change against a previous figure, as a signed whole percent; null when there is
 *  nothing to compare with (a percentage of zero is not a number anyone can use). */
export function change(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
