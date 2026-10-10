// The registration rule in words: the sentences Settings and the reception desk use.
import { describe, expect, test } from "vitest";

import { describeRule, period, regDate, statusLine } from "@/features/billing/registration";
import type { RegistrationPolicy, RegistrationStatus } from "@/features/billing/api";

const pol = (over: Partial<RegistrationPolicy>): RegistrationPolicy => ({
  service_id: "svc_reg", rule: "every_visit", every_count: null, every_unit: "", paper_patients_registered: true, ...over,
});
const st = (over: Partial<RegistrationStatus>): RegistrationStatus => ({ service_id: "svc_reg", rule: "once", due: false, reason: "registered", ...over });

describe("REG-FE-REGWORDS the registration rule in words", () => {
  test("REG-FE-REGWORDS-001 periods read naturally, singular and plural", () => {
    expect(period(1, "day")).toBe("1 day");
    expect(period(30, "day")).toBe("30 days");
    expect(period(1, "week")).toBe("1 week");
    expect(period(2, "month")).toBe("2 months");
  });

  test("REG-FE-REGWORDS-002 dates carry the Ethiopian date and never depend on the browser's month names", () => {
    expect(regDate("2026-09-12")).toBe("12 Sep 2026 (Meskerem 2, 2019 EC)");
    expect(regDate("2026-01-05")).toBe("5 Jan 2026 (Tahsas 27, 2018 EC)");
  });

  test("REG-FE-REGWORDS-003 Settings describes each rule", () => {
    expect(describeRule(pol({}), "Registration")).toBe("Every patient pays Registration on every visit.");
    expect(describeRule(pol({ rule: "once" }), "Registration")).toBe("A new patient pays Registration once. They never pay it again.");
    expect(describeRule(pol({ rule: "every", every_count: 2, every_unit: "month" }), "Registration"))
      .toBe("A new patient pays Registration. They pay it again 2 months after they last paid it.");
    expect(describeRule(pol({ rule: "every", every_count: null, every_unit: "" }), "Registration")).toBe("Choose how long Registration lasts.");
  });

  test("REG-FE-REGWORDS-004 the desk is told why, for every reason", () => {
    expect(statusLine(st({ registered_on: "2026-09-12" }))).toBe("Registered 12 Sep 2026 (Meskerem 2, 2019 EC). One time only.");
    expect(statusLine(st({ rule: "every", registered_on: "2026-09-12", valid_until: "2026-10-12" })))
      .toBe("Registered 12 Sep 2026 (Meskerem 2, 2019 EC), valid until 12 Oct 2026 (Tikimt 2, 2019 EC).");
    expect(statusLine(st({ reason: "paper", registered_on: "2026-08-01" }))).toBe("Registered on the paper register before ClinicOS.");
    expect(statusLine(st({ rule: "every", reason: "paper", registered_on: "2026-08-01", valid_until: "2026-09-01" })))
      .toBe("On the paper register; counted from 1 Aug 2026 (Hamle 25, 2018 EC), valid until 1 Sep 2026 (Nehase 26, 2018 EC).");
    expect(statusLine(st({ reason: "owed", registered_on: "2026-09-20" }))).toBe("Registration from 20 Sep 2026 (Meskerem 10, 2019 EC) is still unpaid. Collect that one; no new fee.");
    expect(statusLine(st({ rule: "every", due: true, reason: "expired", valid_until: "2026-10-02" }))).toBe("Registration ran out on 2 Oct 2026 (Meskerem 22, 2019 EC). Paying again today.");
    expect(statusLine(st({ due: true, reason: "never_registered" }))).toBe("New patient: first registration.");
    expect(statusLine(st({ due: true, reason: "every_visit" }))).toBe("");
    expect(statusLine(st({ due: true, reason: "no_policy" }))).toBe("");
  });
});
