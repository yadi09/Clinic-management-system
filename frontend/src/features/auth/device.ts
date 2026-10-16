// What a browser's user-agent string says about the device, in words a person reads.
export interface DeviceInfo { browser: string; os: string; kind: "phone" | "tablet" | "computer" }

export function describeDevice(ua: string): DeviceInfo {
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\/|Opera/.test(ua) ? "Opera" :
    /SamsungBrowser/.test(ua) ? "Samsung Internet" :
    /Firefox\//.test(ua) ? "Firefox" :
    /CriOS|Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS" :
    /Android/.test(ua) ? "Android" :
    /Windows NT 10/.test(ua) ? "Windows 10/11" :
    /Windows/.test(ua) ? "Windows" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /CrOS/.test(ua) ? "ChromeOS" :
    /Linux/.test(ua) ? "Linux" : "Unknown system";
  const kind = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "tablet" : /iPhone|iPod|Android|Mobile/.test(ua) ? "phone" : "computer";
  return { browser, os, kind };
}

/** "Ethiopia" for "ET"; "" when unknown. */
export function countryName(code: string): string {
  if (!code) return "";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code; } catch { return code; }
}

/** "Active now", "Active 12 min ago", "Active 3 h ago", "Active 2 days ago". */
export function lastActive(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 5) return "Active now";
  if (min < 60) return `Active ${min} min ago`;
  if (min < 60 * 24) return `Active ${Math.round(min / 60)} h ago`;
  const d = Math.round(min / 1440);
  return `Active ${d} day${d === 1 ? "" : "s"} ago`;
}
