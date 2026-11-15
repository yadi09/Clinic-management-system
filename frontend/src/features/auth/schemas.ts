import { z } from "zod";

export const loginSchema = z.object({
  workspace: z.string().min(1, "Workspace is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginValues = z.infer<typeof loginSchema>;

/** Step one: which clinic. */
export const clinicCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "Enter your clinic code")
    .regex(/^[a-z0-9][a-z0-9-]*$/i, "Use letters, numbers and dashes only"),
});
export type ClinicCodeValues = z.infer<typeof clinicCodeSchema>;

/** Step two: who you are at that clinic. */
export const credentialsSchema = z.object({
  email: z.string().trim().min(1, "Enter your email").email("That doesn't look like an email"),
  password: z.string().min(1, "Enter your password"),
});
export type CredentialsValues = z.infer<typeof credentialsSchema>;

export const mfaSchema = z.object({
  code: z
    .string()
    .min(6, "Enter the 6-digit code")
    .max(6, "Enter the 6-digit code")
    .regex(/^\d{6}$/, "Code must be 6 digits"),
});
export type MfaValues = z.infer<typeof mfaSchema>;
