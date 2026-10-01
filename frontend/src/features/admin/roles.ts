// Which roles make sense for this clinic.
//
// Every clinic is provisioned with the same set of roles, so a dental practice was
// offered "Nurse", "Pharmacist" and "Lab technician" when inviting staff — jobs for
// modules it does not run, whose permissions open pages it cannot see.
const ROLE_NEEDS: Record<string, (flagOn: (f: string) => boolean) => boolean> = {
  // The nurse role is triage and vitals; a dental clinic has neither.
  nurse: (on) => !on("dental"),
  pharmacist: (on) => on("pharmacy"),
  pharmacy_manager: (on) => on("pharmacy"),
  lab_technician: (on) => on("laboratory"),
  lab_manager: (on) => on("laboratory"),
};

/** Whether to offer this role here. A role someone already holds is always shown,
 *  so it can be taken away. */
export function roleOffered(code: string, flagOn: (f: string) => boolean, held = false): boolean {
  const needs = ROLE_NEEDS[code];
  return held || !needs || needs(flagOn);
}
