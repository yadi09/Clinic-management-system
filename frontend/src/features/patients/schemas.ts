import { z } from "zod";

export const patientSchema = z.object({
  mrn: z.string().optional(), // existing card ID; blank = auto-generate
  first_name: z.string().min(1, "First name is required"),
  middle_name: z.string().optional(),
  last_name: z.string().optional(),
  gender: z.enum(["male", "female", "other", "unknown"]),
  // Optional: empty when the patient's age is not known (clinic feedback, 2026-10-01).
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a full date of birth, or switch to age").or(z.literal("")),
  // True when the clinic gave an age and dob was worked out from it.
  dob_estimated: z.boolean().optional(),
  national_id: z.string().optional(),
  passport_no: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  blood_group: z.string().optional(),
});

export type PatientValues = z.infer<typeof patientSchema>;
