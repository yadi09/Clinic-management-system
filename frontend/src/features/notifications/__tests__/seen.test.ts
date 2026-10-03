// "Seen" decides whether the sign-in pop-up appears. What must hold: it is a point in
// time per user on this device, it only moves forward, reading the newest notice does
// not make the next unread one look new, one user's seen point never silences
// another's pop-up, and when storage is blocked nothing breaks (the pop-up simply
// shows whenever something is unread). Times come from the server's created_at, so
// the device clock and time zone do not matter.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AppNotification } from "@/features/notifications/api";
import { hasUnseen, markSeen, seenUntil } from "@/features/notifications/seen";

const N = (id: string, created_at: string): AppNotification => ({
  id, kind: "missed_visit", title: "Missed visit", body: "", href: "/patients/pat_a", created_at, read_at: null,
});
const older = N("n1", "2026-10-01T06:00:00Z");
const newer = N("n2", "2026-10-02T06:00:00Z");

describe("REG-FE-NOTIFSEEN seen point", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  test("REG-FE-NOTIFSEEN-001 nothing seen yet: everything unread is unseen", () => {
    expect(seenUntil("usr_a")).toBe(0);
    expect(hasUnseen("usr_a", [older])).toBe(true);
    expect(hasUnseen("usr_a", [])).toBe(false);
    expect(hasUnseen("usr_a", undefined)).toBe(false);
  });

  test("REG-FE-NOTIFSEEN-002 seeing a list moves the point to its newest, and that list is no longer new", () => {
    markSeen("usr_a", [older, newer]);
    expect(seenUntil("usr_a")).toBe(Date.parse(newer.created_at));
    expect(hasUnseen("usr_a", [older, newer])).toBe(false);
    // The older one, still unread after the newest was read, does not bring the pop-up back.
    expect(hasUnseen("usr_a", [older])).toBe(false);
    expect(hasUnseen("usr_a", [N("n3", "2026-10-02T06:00:01Z")])).toBe(true);
  });

  test("REG-FE-NOTIFSEEN-003 the point never moves backward", () => {
    markSeen("usr_a", [newer]);
    markSeen("usr_a", [older]);
    expect(seenUntil("usr_a")).toBe(Date.parse(newer.created_at));
  });

  test("REG-FE-NOTIFSEEN-004 per user: one person's seen point does not hide another's notices", () => {
    markSeen("usr_a", [newer]);
    expect(hasUnseen("usr_b", [older])).toBe(true);
    expect(seenUntil("usr_b")).toBe(0);
  });

  test("REG-FE-NOTIFSEEN-005 no user, no items, or unparseable times store nothing", () => {
    markSeen("", [newer]);
    markSeen("usr_a", undefined);
    markSeen("usr_a", []);
    markSeen("usr_a", [N("bad", "not a time")]);
    expect(localStorage.length).toBe(0);
  });

  test("REG-FE-NOTIFSEEN-006 a corrupted stored value counts as nothing seen", () => {
    localStorage.setItem("clinicos.notifications.seen.usr_a", "garbage");
    expect(seenUntil("usr_a")).toBe(0);
    expect(hasUnseen("usr_a", [older])).toBe(true);
  });

  test("REG-FE-NOTIFSEEN-007 storage blocked: reads say nothing seen, writes do not throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(seenUntil("usr_a")).toBe(0);
    expect(() => markSeen("usr_a", [newer])).not.toThrow();
    expect(hasUnseen("usr_a", [older])).toBe(true);
  });

  test("REG-FE-NOTIFSEEN-008 storage readable but not writable: markSeen still does not throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => markSeen("usr_a", [newer])).not.toThrow();
    expect(seenUntil("usr_a")).toBe(0);
  });
});
