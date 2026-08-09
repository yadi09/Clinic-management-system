// Ethiopian (Ge'ez) calendar conversion — dependency-free and exact.
//
// The Ethiopian calendar has 13 months: 12 of 30 days + Pagumē (5 days, 6 in a
// leap year). It runs ~7–8 years behind the Gregorian calendar; the new year
// (Meskerem 1) falls around September 11. Conversion goes through the Julian Day
// Number (JDN). Verified anchors: Meskerem 1, 2018 EC = 11 Sep 2025 GC.

const ETH_EPOCH = 1724221; // JDN of Meskerem 1, year 1 EC (Amete Mihret)

/** Latin transliterations, index 0..12 (Pagumē is the 13th). */
export const ETH_MONTHS = [
  "Meskerem", "Tikimt", "Hidar", "Tahsas", "Tir", "Yekatit",
  "Megabit", "Miyazia", "Ginbot", "Sene", "Hamle", "Nehase", "Pagumē",
] as const;

export interface EthDate {
  year: number;
  month: number; // 1..13
  day: number; // 1..30 (Pagumē: 1..5/6)
}

function gregorianToJDN(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

// Days from the epoch to Meskerem 1 of `year` (EC leap = year % 4 === 3, matching
// the forward term floor(year/4)).
const daysToYear = (year: number) => 365 * (year - 1) + Math.floor(year / 4);

function jdnToEthiopian(jdn: number): EthDate {
  const off = jdn - ETH_EPOCH;
  // Estimate the year, then nudge ±1 so daysToYear(year) <= off < daysToYear(year+1).
  // Directly inverts the forward formula, so it's exact at every leap boundary.
  let year = Math.floor(off / 365.25) + 1;
  while (daysToYear(year) > off) year--;
  while (daysToYear(year + 1) <= off) year++;
  const doy = off - daysToYear(year); // 0-based day within the year
  return { year, month: Math.floor(doy / 30) + 1, day: (doy % 30) + 1 };
}

/** Convert a JS Date (using its LOCAL calendar day) to an Ethiopian date. */
export function toEthiopian(input: Date | string): EthDate {
  const d = typeof input === "string" ? parseLocalDate(input) : input;
  return jdnToEthiopian(gregorianToJDN(d.getFullYear(), d.getMonth() + 1, d.getDate()));
}

const ethiopianToJDN = (year: number, month: number, day: number) => daysToYear(year) + ETH_EPOCH + 30 * (month - 1) + day - 1;

function jdnToGregorian(jdn: number): { year: number; month: number; day: number } {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  };
}

/** Ethiopian year is leap (Pagumē has 6 days) when year % 4 === 3. */
export const isEthiopianLeap = (year: number) => ((year % 4) + 4) % 4 === 3;

/** Days in an Ethiopian month: 30 for months 1–12; Pagumē (13) has 5 or 6. */
export const ethiopianDaysInMonth = (year: number, month: number) => (month === 13 ? (isEthiopianLeap(year) ? 6 : 5) : 30);

/** Convert an Ethiopian date to a Gregorian "YYYY-MM-DD" string. */
export function ethiopianToGregorianISO(year: number, month: number, day: number): string {
  const g = jdnToGregorian(ethiopianToJDN(year, month, day));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(g.year).padStart(4, "0")}-${p(g.month)}-${p(g.day)}`;
}

/** Parse "YYYY-MM-DD" as a local date (avoids the UTC off-by-one for date-only strings). */
function parseLocalDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(s);
}

/** "Hamle 4, 2018" (or "4 Hamle 2018" when dayFirst). */
export function formatEthiopian(input: Date | string, opts: { dayFirst?: boolean } = {}): string {
  const e = toEthiopian(input);
  const name = ETH_MONTHS[e.month - 1];
  return opts.dayFirst ? `${e.day} ${name} ${e.year}` : `${name} ${e.day}, ${e.year}`;
}

/** "Hamle 2018" — month + year only. */
export function formatEthiopianMonth(input: Date | string): string {
  const e = toEthiopian(input);
  return `${ETH_MONTHS[e.month - 1]} ${e.year}`;
}

/**
 * A concise EC label for a Gregorian span [from, to). If both ends fall in the
 * same EC month → "Hamle 2018"; if the year matches → "Sene–Hamle 2018"; else
 * "Nehase 2017 – Meskerem 2018".
 */
export function formatEthiopianRange(from: Date, to: Date): string {
  const a = toEthiopian(from);
  const b = toEthiopian(new Date(to.getTime() - 1)); // `to` is exclusive
  if (a.year === b.year && a.month === b.month) return `${ETH_MONTHS[a.month - 1]} ${a.year}`;
  if (a.year === b.year) return `${ETH_MONTHS[a.month - 1]}–${ETH_MONTHS[b.month - 1]} ${a.year}`;
  return `${ETH_MONTHS[a.month - 1]} ${a.year} – ${ETH_MONTHS[b.month - 1]} ${b.year}`;
}
