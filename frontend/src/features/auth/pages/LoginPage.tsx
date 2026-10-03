import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocation, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/app/auth-context";
import { AppError, SESSION_END_KEY } from "@/lib/api-client";
import { isMfaChallenge, loginApi } from "@/features/auth/api";
import { loginSchema, type LoginValues } from "@/features/auth/schemas";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();
  // Sent here because the server ended the session (locked out, clinic suspended,
  // sign-in not renewed): say so once, instead of an empty form.
  const [formError, setFormError] = useState<string | null>(() => {
    try {
      const why = sessionStorage.getItem(SESSION_END_KEY);
      sessionStorage.removeItem(SESSION_END_KEY);
      if (why === "clinic-suspended") return "This clinic's workspace has been suspended. Please contact ClinicOS support.";
      if (why === "expired") return "Your session has ended. Please sign in again.";
    } catch {
      /* no storage: show the plain form */
    }
    return null;
  });

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? "/";

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  const onSubmit = async (values: LoginValues) => {
    setFormError(null);
    try {
      const res = await loginApi(values);
      if (isMfaChallenge(res)) {
        navigate("/mfa", { state: { mfaToken: res.mfa_token, from } });
        return;
      }
      signIn(res.access_token, res.user);
      navigate(from, { replace: true });
    } catch (err) {
      setFormError(err instanceof AppError ? err.message : "Unable to sign in. Please try again.");
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Access your clinic workspace</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="workspace">Workspace</Label>
            <Input id="workspace" placeholder="demo" autoComplete="organization" {...register("workspace")} />
            {errors.workspace && <p className="text-sm text-destructive">{errors.workspace.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="username" {...register("email")} />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" autoComplete="current-password" {...register("password")} />
            {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
