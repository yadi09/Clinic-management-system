import { z } from "zod";

export const patientSchema = z.object({
  first_name: z.string().min(1, "First name is required"),
  middle_name: z.string().optional(),
  last_name: z.string().min(1, "Last name is required"),
  gender: z.enum(["male", "female", "other", "unknown"]),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  national_id: z.string().optional(),
  passport_no: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email("Invalid email").optional().or(z.literal("")),
  blood_group: z.string().optional(),
});

export type PatientValues = z.infer<typeof patientSchema>;
