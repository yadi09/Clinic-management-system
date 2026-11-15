import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocation, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/app/auth-context";
import { verifyMfaApi, type ClinicCard } from "@/features/auth/api";
import { ClinicBadge } from "@/features/auth/ClinicBadge";
import { codeError } from "@/features/auth/messages";
import { mfaSchema, type MfaValues } from "@/features/auth/schemas";

/** The second step for an account with an authenticator app. The code submits
 *  itself on its sixth digit, typed or pasted (spaces and dashes are dropped). */
export function MfaPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);

  const state = location.state as { mfaToken?: string; from?: string; clinic?: ClinicCard; email?: string } | null;
  const mfaToken = state?.mfaToken;
  const from = state?.from ?? "/";

  useEffect(() => {
    if (!mfaToken) navigate("/login", { replace: true });
  }, [mfaToken, navigate]);

  const {
    register, handleSubmit, setValue, setFocus, formState: { errors, isSubmitting },
  } = useForm<MfaValues>({ resolver: zodResolver(mfaSchema) });

  useEffect(() => setFocus("code"), [setFocus]);

  // Without a challenge the page has already gone back to sign-in (effect above).
  const onSubmit = async (values: MfaValues) => {
    setFormError(null);
    try {
      const res = await verifyMfaApi({ mfa_token: mfaToken as string, code: values.code });
      signIn(res.access_token, res.user);
      navigate(from, { replace: true });
    } catch (err) {
      setFormError(codeError(err));
      setValue("code", "");
      setFocus("code");
    }
  };
  const submit = handleSubmit(onSubmit);

  const field = register("code", {
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
      if (digits !== e.target.value) setValue("code", digits);
      if (digits.length === 6 && !isSubmitting) void submit();
    },
  });

  return (
    <Card className="w-full">
      <CardHeader className="space-y-4">
        {state?.clinic && <ClinicBadge clinic={state.clinic} detail={state.email} />}
        <div className="space-y-1.5">
          <CardTitle className="text-2xl">Two-step sign-in</CardTitle>
          <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="code">Authentication code</Label>
            <Input id="code" inputMode="numeric" autoComplete="one-time-code" placeholder="••••••"
              className="h-12 aria-[invalid=true]:border-destructive text-center font-mono text-2xl font-semibold tracking-[0.5em] md:text-2xl"
              aria-invalid={!!errors.code} aria-describedby={errors.code ? "code-error" : undefined} {...field} />
            {errors.code && <p id="code-error" className="text-sm text-destructive">{errors.code.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Verifying…" : "Verify"}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" onClick={() => navigate("/login", { replace: true, state: { from: { pathname: from } } })}
              className="rounded font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              ← Use another account
            </button>
            <button type="button" aria-expanded={help} onClick={() => setHelp((h) => !h)}
              className="rounded font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Lost your phone?
            </button>
          </div>
          {help && (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              Without your authenticator app you can&apos;t finish signing in. Ask your clinic owner or admin to contact
              ClinicOS support, who can reset two-step sign-in for your account.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
