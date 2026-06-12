import { z } from "zod";

export const loginSchema = z.object({
  workspace: z.string().min(1, "Workspace is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});
export type LoginValues = z.infer<typeof loginSchema>;

export const mfaSchema = z.object({
  code: z
    .string()
    .min(6, "Enter the 6-digit code")
    .max(6, "Enter the 6-digit code")
    .regex(/^\d{6}$/, "Code must be 6 digits"),
});
export type MfaValues = z.infer<typeof mfaSchema>;
