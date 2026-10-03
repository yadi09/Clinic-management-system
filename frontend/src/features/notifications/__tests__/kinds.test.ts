// How each kind of notification reads. What must hold: a missed dental visit leads
// with the patient's name and card, says which visit of which treatment, and carries
// the day it was due; a patient waiting says where; anything this screen does not
// know (or an older notice without fields) still shows its own title and sentence.
// The pop-up's title names what is waiting in plain words and counts it right.
import { describe, expect, test } from "vitest";
import { Bell, CalendarX2, UserRound } from "lucide-react";

import type { AppNotification } from "@/features/notifications/api";
import { CATEGORIES, LIVE_KINDS, present, spoken, summarize } from "@/features/notifications/kinds";

const N = (kind: string, data: Record<string, unknown> | undefined, extra: Partial<AppNotification> = {}): AppNotification => ({
  id: "ntf_1", kind, title: "Missed visit", body: "Almaz Haile missed visit 2 of Root canal on 1 Oct.",
  data, href: "/patients/pat_a", created_at: "2026-10-01T06:00:00Z", read_at: null, ...extra,
});

describe("REG-FE-NOTIFKIND how notifications read", () => {
  test("REG-FE-NOTIFKIND-001 missed visit: name, card, visit of treatment, and the day", () => {
    const p = present(N("missed_visit", { patient: " Almaz Haile ", card: "C-104", course: "Root canal", visit: 2, date: "2026-10-01" }));
    expect(p.icon).toBe(CalendarX2);
    expect(p).toMatchObject({ headline: "Almaz Haile", tag: "Card C-104", detail: "Missed visit 2 of Root canal", date: "2026-10-01" });
  });

  test("REG-FE-NOTIFKIND-002 missed visit: missing visit number, course or card degrade to readable text", () => {
    expect(present(N("missed_visit", { patient: "Almaz", course: "Scaling" })).detail).toBe("Missed visit of Scaling");
    const bare = present(N("missed_visit", { patient: "Almaz", card: "  ", visit: "2" }));
    expect(bare).toMatchObject({ headline: "Almaz", detail: "Missed a visit" });
    expect(bare.tag).toBeUndefined();
    expect(bare.date).toBeUndefined();
  });

  test("REG-FE-NOTIFKIND-003 an older missed-visit notice without fields shows its title and sentence", () => {
    for (const data of [undefined, {}, { patient: "   " }, { patient: 7 }]) {
      const p = present(N("missed_visit", data as Record<string, unknown> | undefined));
      expect(p.icon).toBe(Bell);
      expect(p).toMatchObject({ headline: "Missed visit", detail: "Almaz Haile missed visit 2 of Root canal on 1 Oct." });
    }
  });

  test("REG-FE-NOTIFKIND-004 patient waiting: name, card, and the department when known", () => {
    const p = present(N("patient_waiting", { patient: "Selam Bekele", card: "C-9", department: "Dental" }));
    expect(p.icon).toBe(UserRound);
    expect(p).toMatchObject({ headline: "Selam Bekele", tag: "Card C-9", detail: "Waiting for you in Dental" });
    const q = present(N("patient_waiting", { patient: "Selam Bekele" }));
    expect(q.detail).toBe("Waiting for you");
    expect(q.tag).toBeUndefined();
    expect(present(N("patient_waiting", {}, { title: "Patient waiting", body: "Someone is waiting." })))
      .toMatchObject({ headline: "Patient waiting", detail: "Someone is waiting." });
  });

  test("REG-FE-NOTIFKIND-005 an unknown kind still shows, from title and body", () => {
    const p = present(N("lab_ready", { patient: "X" }, { title: "Lab result ready", body: "CBC for Almaz is in." }));
    expect(p).toMatchObject({ icon: Bell, headline: "Lab result ready", detail: "CBC for Almaz is in." });
  });

  test("REG-FE-NOTIFKIND-006 categories in display order; only patients waiting are live", () => {
    expect(CATEGORIES.map((c) => c.kind)).toEqual(["patient_waiting", "missed_visit"]);
    expect(CATEGORIES.find((c) => c.kind === "missed_visit")?.label).toBe("Missed visits");
    expect(LIVE_KINDS.has("patient_waiting")).toBe(true);
    expect(LIVE_KINDS.has("missed_visit")).toBe(false);
  });

  test("REG-FE-NOTIFKIND-007 the spoken sentence", () => {
    expect(spoken(N("patient_waiting", { patient: "Selam Bekele" }))).toBe("Selam Bekele is waiting for you.");
    expect(spoken(N("patient_waiting", undefined))).toBe("A patient is waiting for you.");
    expect(spoken(N("missed_visit", { patient: "Almaz" }, { title: "Missed visit" }))).toBe("Missed visit");
  });

  test("REG-FE-NOTIFKIND-008 pop-up summary: missed visits, counted", () => {
    const one = [N("missed_visit", { patient: "A" })];
    expect(summarize(one, 1)).toEqual({
      title: "A visit was missed", lead: "These visits passed without being marked done. Open a patient to rebook.",
    });
    const three = [1, 2, 3].map((i) => N("missed_visit", { patient: `P${i}` }, { id: `n${i}` }));
    expect(summarize(three, 3).title).toBe("3 visits were missed");
  });

  test("REG-FE-NOTIFKIND-009 pop-up summary: patients waiting, by name when only one", () => {
    expect(summarize([N("patient_waiting", { patient: "Selam" })], 1)).toEqual({
      title: "Selam is waiting for you", lead: "Open a patient to start the visit.",
    });
    expect(summarize([N("patient_waiting", {})], 1).title).toBe("A patient is waiting for you");
    const two = [N("patient_waiting", {}, { id: "a" }), N("patient_waiting", {}, { id: "b" })];
    expect(summarize(two, 2).title).toBe("2 patients are waiting for you");
  });

  test("REG-FE-NOTIFKIND-010 pop-up summary: mixed kinds, or more than shown, is a plain unread count", () => {
    const lead = "Here's what needs your attention.";
    expect(summarize([N("missed_visit", {}), N("patient_waiting", {}, { id: "b" })], 2)).toEqual({ title: "You have 2 unread notifications", lead });
    // Five missed visits shown of eight unread: the title must not claim "5 visits".
    const five = [1, 2, 3, 4, 5].map((i) => N("missed_visit", {}, { id: `n${i}` }));
    expect(summarize(five, 8).title).toBe("You have 8 unread notifications");
    expect(summarize([N("patient_waiting", {})], 4).title).toBe("You have 4 unread notifications");
    expect(summarize([], 1).title).toBe("You have 1 unread notification");
  });
});
