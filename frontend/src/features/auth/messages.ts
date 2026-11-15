// What a refused sign-in means to the person at the desk, and what to do next.
// The server deliberately gives one answer for an unknown email and a wrong
// password; so do we.
import { AppError } from "@/lib/api-client";

const OFFLINE = "Can't reach ClinicOS. Check the internet connection and try again.";

export function signInError(err: unknown, clinicName: string): string {
  if (!(err instanceof AppError)) return OFFLINE;
  switch (err.code) {
    case "NETWORK":
    case "TIMEOUT":
      return OFFLINE;
    case "ACCOUNT_LOCKED":
      return "Too many wrong tries. This account is paused for 15 minutes to keep it safe. Wait, or ask your clinic admin for a reset link.";
    case "ACCOUNT_INACTIVE":
      return `Your account at ${clinicName} is switched off. Ask your clinic owner or admin to turn it back on.`;
    case "TENANT_INACTIVE":
      return `${clinicName}'s ClinicOS workspace is paused. The clinic owner should contact ClinicOS support.`;
    case "RATE_LIMITED":
      return "Too many tries from this connection. Wait a minute, then try again.";
  }
  if (err.status === 401)
    return `That email and password don't match an account at ${clinicName}. Check both, and Caps Lock. After 5 wrong tries the account pauses for 15 minutes.`;
  if (err.status >= 500) return "ClinicOS had a problem signing you in. Please try again in a moment.";
  return err.message || "Unable to sign in. Please try again.";
}

export function codeError(err: unknown): string {
  if (!(err instanceof AppError)) return OFFLINE;
  if (err.code === "NETWORK" || err.code === "TIMEOUT") return OFFLINE;
  if (err.status === 401) return "That code isn't right, or it has expired. Enter the newest code from your app.";
  if (err.code === "RATE_LIMITED") return "Too many tries from this connection. Wait a minute, then try again.";
  if (err.status >= 500) return "ClinicOS had a problem checking the code. Please try again in a moment.";
  return err.message || "Verification failed. Please try again.";
}
