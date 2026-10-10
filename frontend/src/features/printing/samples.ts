// Made-up papers for the preview in Settings: the clinic sees its own look on a
// realistic receipt or prescription before any real patient's is printed.
import type { DocData } from "@/features/printing/engine";
import type { DocId } from "@/features/printing/settings";

export function sampleFor(doc: DocId): DocData | null {
  const when = new Date().toISOString();
  switch (doc) {
    case "receipt":
      return {
        doc: "receipt",
        data: {
          kind: "payment", number: "RCP-004217", when, patient: "Abebe Kebede", mrn: "P000033", phone: "0911 00 00 00",
          lines: [{ description: "Root canal — visit 2", amount: "1500.00" }, { description: "Registration", amount: "200.00" }],
          total: "1700.00", currency: "ETB", method: "Telebirr", reference: "CJ47X92KLM", cashier: "Hana Desta", balance: "3000.00",
        },
      };
    case "prescription":
      return {
        doc: "prescription",
        data: {
          clinic: "", rxRef: "Rx 4F2A91", qrData: "RX:sample", patient: "Abebe Kebede", mrn: "P000033", age: 29, gender: "male",
          weightKg: "62", prescriber: "Dr Yonas Bekele", prescriberLicense: "FMHACA-12345", when,
          diagnoses: [{ code: "K04.0", description: "Pulpitis" }],
          meds: [
            { drug_name: "Amoxicillin 500 mg capsule", dose: "1 capsule", frequency: "3 times a day", duration: "7 days", instructions: "Finish the course" },
            { drug_name: "Ibuprofen 400 mg tablet", dose: "1 tablet", frequency: "3 times a day", duration: "3 days", instructions: "After food" },
          ],
          note: "Review in one week.", allergies: ["Penicillin"],
        },
      };
    case "labrequest":
      return {
        doc: "labrequest",
        data: {
          clinic: "", ref: "Lab 8C31B2", qrData: "LAB:sample", patient: "Abebe Kebede", mrn: "P000033", age: 29, gender: "male",
          prescriber: "Dr Yonas Bekele", prescriberLicense: "FMHACA-12345", when,
          tests: ["Complete blood count", "Blood glucose (fasting)", "Hepatitis B surface antigen"], indication: "Pre-operative assessment",
        },
      };
    case "statement":
      return {
        doc: "statement",
        data: {
          patient: "Abebe Kebede", mrn: "P000033", phone: "0911 00 00 00", currency: "ETB",
          lines: [
            { date: "2026-09-12", description: "Root canal — visit 1", status: "Paid", amount: "1500.00" },
            { date: "2026-09-26", description: "Root canal — visit 2", status: "Paid", amount: "1500.00" },
            { date: "2026-10-03", description: "Crown", status: "Awaiting payment", amount: "4200.00" },
          ],
          charged: "7200.00", paid: "3000.00", refunded: "0", outstanding: "4200.00", issuedBy: "Hana Desta",
          payTo: [{ label: "CBE (Sample Clinic)", account: "1000 1234 5678" }, { label: "Telebirr", account: "0911 00 00 00" }],
        },
      };
    case "zreport":
      return {
        doc: "zreport",
        data: {
          cashier: "Hana Desta", businessDate: when.slice(0, 10), currency: "ETB",
          byMethod: [
            { label: "Cash", total: "8400.00", count: 11, cash: true },
            { label: "Telebirr", total: "3200.00", count: 4 },
          ],
          expected: "8400.00", counted: "8350.00", variance: "-50.00", note: "A 50 birr note was torn.",
        },
      };
    case "labreport":
      return {
        doc: "labreport",
        data: {
          sampleNo: 1042, testName: "Complete blood count", patient: "Abebe Kebede", mrn: "P000033", priority: "routine",
          status: "validated", orderedBy: "Dr Yonas Bekele", specimen: "Whole blood", collectedBy: "Selam T.",
          collectedAt: when, reportedAt: when, validatedAt: when, validatedBy: "Dr Meron Alemu",
          analytes: [
            { name: "Haemoglobin", value: "13.4", unit: "g/dL", refLow: "13.0", refHigh: "17.0", flag: "normal" },
            { name: "White cell count", value: "11.8", unit: "x10^9/L", refLow: "4.0", refHigh: "11.0", flag: "high" },
            { name: "Platelets", value: "250", unit: "x10^9/L", refLow: "150", refHigh: "400", flag: "normal" },
          ],
          critical: false,
        },
      };
    case "certificate":
      return {
        doc: "certificate",
        data: {
          clinic: "", ref: "MC-000123", kind: "sick_leave", patient: "Abebe Kebede", mrn: "P000033", age: "29", gender: "male",
          diagnosis: "Acute pulpitis", showDiagnosis: false, restDays: 3,
          restFrom: when.slice(0, 10), restTo: when.slice(0, 10), issuedOn: when.slice(0, 10),
          issuedBy: "Dr Yonas Bekele", status: "active", qrData: "MC:sample",
        },
      };
    case "exam":
      return {
        doc: "exam",
        data: {
          patient: "Abebe Kebede", mrn: "P000033", age: 29, gender: "male", visitDate: when.slice(0, 10), recordedBy: "Dr Yonas Bekele",
          chiefComplaint: "Pain in the lower right molar for three days.", hpi: "Worse at night and with cold drinks.",
          pastDentalHistory: "Filling on the same tooth two years ago.",
          extraoral: ["No swelling", "TMJ normal"], intraoral: ["Deep caries 46", "Tender to percussion 46"],
          investigations: ["Periapical X-ray"], investigationResults: "Periapical radiolucency at 46.",
          diagnosis: "Irreversible pulpitis 46", treatmentPlan: "Root canal treatment then crown.",
          treatmentGiven: ["Access opening", "Pulp extirpation"], anaesthesia: "Lignocaine 2%",
          procedures: [{ tooth: "46", procedure: "Pulpectomy", notes: "Temporary dressing placed" }],
          postop: "Avoid chewing on that side until the crown is fitted.",
        },
      };
    case "dispense":
      return {
        doc: "dispense",
        data: {
          rxRef: "R-1042", patient: "Abebe Kebede", mrn: "P000033", prescriber: "Dr Yonas Bekele", when,
          items: [
            { drug: "Amoxicillin 500 mg capsule", sig: "1 capsule, 3 times a day, 7 days", qty: 21, batch: "AMX-2209", expiry: "2027-08" },
            { drug: "Ibuprofen 400 mg tablet", sig: "1 tablet, 3 times a day, 3 days, after food", qty: 9, batch: "IBU-2301", expiry: "2027-11" },
          ],
          allergies: ["Penicillin"], counselling: "Finish the full course. Take ibuprofen after food.", dispensedBy: "Selam T.",
        },
      };
    default:
      return null;
  }
}
