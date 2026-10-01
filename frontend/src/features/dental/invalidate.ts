// One place that knows what a dental change invalidates.
//
// A treatment session is not one record: it is a row in the dental summary, a charge
// in the patient's ledger, an entry on the appointments timeline, a dot on the clinic
// calendar and a line on the outstanding-balance list. Every mutation in the dental
// module has so far picked its own subset by hand, and they disagree — collecting a
// session invalidates only `dental-summary`, so the payment history keeps showing
// pre-collection totals until the page is reloaded, and the front desk asks a patient
// for money they have already queued to pay.
//
// Adding a new query key to this list is a one-line fix everywhere at once; the
// alternative is finding all fourteen call sites again.
import type { QueryClient } from "@tanstack/react-query";

/**
 * Refresh everything a change to this patient's dental record can affect.
 *
 * Deliberately broad: these are all cheap, patient-scoped reads, and a stale money
 * figure in front of a cashier costs more than a refetch. Clinic-wide lists
 * (calendar, outstanding) are included because a session moving or being paid
 * changes them too.
 */
export function invalidateDental(qc: QueryClient, patientId: string) {
  const keys: unknown[][] = [
    ["dental-summary", patientId],
    ["dental-exams", patientId],
    ["dental-images", patientId],
    ["medical-history", patientId],
    ["patient-charges", patientId],
    ["patient-appointments", patientId],
    ["patient", patientId],
    ["dental-cal"],
    ["dental-outstanding"],
    ["dental-unbilled"],
    ["chairside"],
    ["pending-charges"],
  ];
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}
