// Numbers and dates as they read on paper.
//
// Both are decided here, once, from the clinic's settings and the clinic's own
// clock (Addis Ababa) — never from the computer the paper happens to be printed on,
// which is what made the same receipt read differently at two desks.
import { toEthiopian, ETH_MONTHS } from "@/lib/ethiopian";
import type { Locale } from "@/features/printing/settings";

const ADDIS = "Africa/Addis_Ababa";

export function money(v: string | number, l: Pick<Locale, "thousands">): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "");
  return n.toLocaleString(l.thousands ? "en-US" : "en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: l.thousands,
  });
}

const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "")); }
  else if (n > 0) parts.push(ONES[n]);
  return parts.join(" ");
}

function integerWords(n: number): string {
  if (n === 0) return "zero";
  const scales = [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]] as const;
  const parts: string[] = [];
  for (const [size, name] of scales) {
    if (n >= size) { parts.push(`${below1000(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n > 0) parts.push(below1000(n));
  return parts.join(" ");
}

const NAMES: Record<string, [string, string]> = { ETB: ["birr", "santim"], USD: ["dollars", "cents"], EUR: ["euros", "cents"] };

/** "One thousand five hundred birr and fifty santim only". English; empty for a non-number. */
export function amountInWords(v: string | number, currency: string): string {
  const n = Math.abs(Number(v));
  if (!Number.isFinite(n)) return "";
  const whole = Math.floor(n + 1e-9);
  const cents = Math.round((n - whole) * 100);
  const [major, minor] = NAMES[currency.toUpperCase()] ?? [currency, ""];
  let out = `${integerWords(whole)} ${major}`;
  if (cents > 0) out += ` and ${integerWords(cents)} ${minor || "cents"}`;
  out += " only";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Year/month/day/hour/minute on the clinic's clock. */
function addisParts(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: ADDIS, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

/** A date (and optionally time) in the clinic's chosen calendar(s). `iso` may be a plain
 *  YYYY-MM-DD, which is taken as that day with no time. */
export function fmtDate(iso: string | undefined, l: Pick<Locale, "dates" | "time24">, withTime = false): string {
  if (!iso) return "";
  let y: number, m: number, d: number, h = 0, min = 0, hasTime = false;
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (plain) {
    [y, m, d] = [Number(plain[1]), Number(plain[2]), Number(plain[3])];
  } else {
    const p = addisParts(iso);
    if (!p) return iso;
    ({ y, m, d, h, min } = p);
    hasTime = true;
  }
  const greg = `${d} ${MONTHS[m - 1]} ${y}`;
  const e = toEthiopian(new Date(y, m - 1, d));
  const eth = `${e.day} ${ETH_MONTHS[e.month - 1]} ${e.year}`;
  const day = l.dates === "gregorian" ? greg : l.dates === "ethiopian" ? eth : `${greg} · ${eth}`;
  if (!withTime || !hasTime) return day;
  const hh = String(h).padStart(2, "0"), mm = String(min).padStart(2, "0");
  const time = l.time24 ? `${hh}:${mm}` : `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
  return `${day}, ${time}`;
}
