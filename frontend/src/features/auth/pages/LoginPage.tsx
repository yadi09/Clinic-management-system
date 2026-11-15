// Signing in: first which clinic, then who you are there.
//
// The clinic step is skipped whenever the clinic is already known — from the link
// (/login/<code> or ?clinic=<code>) or from this browser, which remembers the one
// clinic it last signed in to. So most days the page opens on "Sign in to <clinic>"
// and asks only for an email and a password.
import { useEffect, useState, type KeyboardEvent } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/app/auth-context";
import { AppError, SESSION_END_KEY } from "@/lib/api-client";
import { clinicCardApi, isMfaChallenge, loginApi, type ClinicCard } from "@/features/auth/api";
import { ClinicBadge } from "@/features/auth/ClinicBadge";
import { normalizeClinicCode, rememberedClinic } from "@/features/auth/clinic-memory";
import { signInError } from "@/features/auth/messages";
import {
  clinicCodeSchema, credentialsSchema, type ClinicCodeValues, type CredentialsValues,
} from "@/features/auth/schemas";

type Step =
  | { kind: "loading" }
  | { kind: "clinic"; prefill?: string; error?: string }
  | { kind: "signin"; clinic: ClinicCard }
  | { kind: "forgot"; clinic: ClinicCard };

const notFound = (code: string) =>
  `We can't find an open clinic with the code "${code}". Check the code, or ask your clinic admin.`;

/** Looks the code up. A clinic that can't be checked right now (offline, an older
 *  server) still gets the sign-in form under its code: sign-in says if it is wrong. */
async function resolveClinic(code: string): Promise<Step> {
  try {
    return { kind: "signin", clinic: await clinicCardApi(code) };
  } catch (err) {
    if (err instanceof AppError && err.status === 404) return { kind: "clinic", prefill: code, error: notFound(code) };
    return { kind: "signin", clinic: { name: code, slug: code, has_logo: false } };
  }
}

/** Sent here because the server ended the session: say why, once. */
function readSessionEnd(): string | null {
  try {
    const why = sessionStorage.getItem(SESSION_END_KEY);
    sessionStorage.removeItem(SESSION_END_KEY);
    if (why === "clinic-suspended") return "This clinic's workspace has been suspended. Please contact ClinicOS support.";
    if (why === "expired") return "Your session has ended. Please sign in again.";
  } catch {
    /* no storage: show the plain form */
  }
  return null;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ clinic?: string }>();
  const [search] = useSearchParams();
  const [initial] = useState(() =>
    normalizeClinicCode(params.clinic ?? search.get("clinic") ?? rememberedClinic.get() ?? ""));
  const [step, setStep] = useState<Step>(() => (initial ? { kind: "loading" } : { kind: "clinic" }));
  const [notice, setNotice] = useState<string | null>(readSessionEnd);

  useEffect(() => {
    if (!initial) return;
    let live = true;
    void resolveClinic(initial).then((s) => live && setStep(s));
    return () => {
      live = false;
    };
  }, [initial]);

  const changeClinic = () => {
    rememberedClinic.clear();
    setNotice(null);
    setStep({ kind: "clinic" });
    // Off a clinic's own link too; the page someone was sent from survives the change.
    if (params.clinic || search.get("clinic")) navigate("/login", { replace: true, state: location.state });
  };

  const banner = notice && (
    <Alert>
      <AlertDescription>{notice}</AlertDescription>
    </Alert>
  );

  if (step.kind === "loading") {
    return (
      <Card className="w-full">
        <CardContent className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Opening your clinic…
        </CardContent>
      </Card>
    );
  }
  if (step.kind === "clinic") {
    return <ClinicStep key={step.prefill ?? ""} prefill={step.prefill} error={step.error} banner={banner} onFound={setStep} />;
  }
  if (step.kind === "forgot") {
    return <ForgotPassword clinic={step.clinic} onBack={() => setStep({ kind: "signin", clinic: step.clinic })} />;
  }
  return (
    <SignInStep
      clinic={step.clinic}
      banner={banner}
      onChangeClinic={changeClinic}
      onForgot={() => setStep({ kind: "forgot", clinic: step.clinic })}
      onTry={() => setNotice(null)}
    />
  );
}

function ClinicStep({ prefill, error, banner, onFound }: {
  prefill?: string; error?: string; banner: React.ReactNode; onFound: (s: Step) => void;
}) {
  const {
    register, handleSubmit, setError, formState: { errors, isSubmitting },
  } = useForm<ClinicCodeValues>({ resolver: zodResolver(clinicCodeSchema), defaultValues: { code: prefill ?? "" } });

  useEffect(() => {
    if (error) setError("code", { message: error }, { shouldFocus: true });
  }, [error, setError]);

  const onSubmit = async ({ code }: ClinicCodeValues) => {
    const next = await resolveClinic(normalizeClinicCode(code));
    if (next.kind === "clinic") setError("code", { message: next.error }, { shouldFocus: true });
    else onFound(next);
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-2xl">Sign in to your clinic</CardTitle>
        <CardDescription>Enter your clinic code. This browser will remember it for next time.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {banner}
          <div className="space-y-2">
            <Label htmlFor="workspace">Clinic code</Label>
            <Input id="workspace" className="aria-[invalid=true]:border-destructive" autoFocus autoComplete="organization" autoCapitalize="none" spellCheck={false}
              placeholder="e.g. your-clinic-name" aria-invalid={!!errors.code}
              aria-describedby={errors.code ? "workspace-error" : "workspace-hint"}
              {...register("code", { setValueAs: (v: string) => normalizeClinicCode(v) })} />
            {errors.code ? (
              <p id="workspace-error" className="text-sm text-destructive">{errors.code.message}</p>
            ) : (
              <p id="workspace-hint" className="text-xs text-muted-foreground">
                It&apos;s in the sign-in link your clinic gave you. Not sure? Ask your clinic admin.
              </p>
            )}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Finding your clinic…" : "Continue"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SignInStep({ clinic, banner, onChangeClinic, onForgot, onTry }: {
  clinic: ClinicCard; banner: React.ReactNode; onChangeClinic: () => void; onForgot: () => void; onTry: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();
  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/";
  const [formError, setFormError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);

  const {
    register, handleSubmit, setFocus, formState: { errors, isSubmitting },
  } = useForm<CredentialsValues>({ resolver: zodResolver(credentialsSchema) });

  useEffect(() => setFocus("email"), [setFocus]);

  const onSubmit = async ({ email, password }: CredentialsValues) => {
    setFormError(null);
    onTry();
    try {
      const res = await loginApi({ workspace: clinic.slug, email, password });
      // The code is proven right: this browser remembers it for next time.
      rememberedClinic.set(clinic.slug);
      if (isMfaChallenge(res)) {
        navigate("/mfa", { state: { mfaToken: res.mfa_token, from, clinic, email } });
        return;
      }
      signIn(res.access_token, res.user);
      navigate(from, { replace: true });
    } catch (err) {
      setFormError(signInError(err, clinic.name));
      setFocus("password");
    }
  };

  const capsCheck = (e: KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState("CapsLock"));
  const describe = (id: string, err: boolean, extra?: string) =>
    [err ? `${id}-error` : null, extra].filter(Boolean).join(" ") || undefined;

  return (
    <Card className="w-full">
      <CardHeader className="space-y-4">
        <ClinicBadge clinic={clinic} onChange={onChangeClinic} />
        <div className="space-y-1.5">
          <CardTitle className="text-2xl">Welcome back</CardTitle>
          <CardDescription>Sign in with your staff account.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {banner}
          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" className="aria-[invalid=true]:border-destructive" autoComplete="username" autoCapitalize="none" spellCheck={false}
              aria-invalid={!!errors.email} aria-describedby={describe("email", !!errors.email)} {...register("email")} />
            {errors.email && <p id="email-error" className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="password">Password</Label>
              <button type="button" onClick={onForgot}
                className="rounded text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Forgot password?
              </button>
            </div>
            <div className="relative">
              <Input id="password" type={show ? "text" : "password"} autoComplete="current-password" className="pr-11 aria-[invalid=true]:border-destructive"
                aria-invalid={!!errors.password} aria-describedby={describe("password", !!errors.password, caps ? "caps-lock" : undefined)}
                onKeyDown={capsCheck} onKeyUp={capsCheck} {...register("password")} />
              <button type="button" onClick={() => setShow((s) => !s)} aria-pressed={show}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {show ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
            {caps && <p id="caps-lock" role="status" className="text-xs font-medium text-warning">⇪ Caps Lock is on</p>}
            {errors.password && <p id="password-error" className="text-sm text-destructive">{errors.password.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ForgotPassword({ clinic, onBack }: { clinic: ClinicCard; onBack: () => void }) {
  return (
    <Card className="w-full">
      <CardHeader className="space-y-4">
        <ClinicBadge clinic={clinic} />
        <div className="space-y-1.5">
          <CardTitle className="text-2xl">Forgot your password?</CardTitle>
          <CardDescription>For your safety, passwords are reset by your clinic, not by email.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Tell your clinic owner or admin at {clinic.name}.</li>
          <li>They open <strong>Users</strong>, choose you, then <strong>Reset link</strong>.</li>
          <li>Open the link they give you and set a new password.</li>
        </ol>
        <Button type="button" variant="outline" className="w-full" onClick={onBack} autoFocus>
          Back to sign in
        </Button>
      </CardContent>
    </Card>
  );
}
