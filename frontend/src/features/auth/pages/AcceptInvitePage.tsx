import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/app/auth-context";
import { apiFetch, AppError } from "@/lib/api-client";
import type { TokenResponse } from "@/features/auth/api";

const schema = z
  .object({
    password: z.string().min(8, "At least 8 characters"),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { message: "Passwords do not match", path: ["confirm"] });

type Values = z.infer<typeof schema>;

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const onSubmit = async (values: Values) => {
    setFormError(null);
    try {
      // The same endpoint serves an invitation and a password reset. A reset
      // deliberately does NOT sign anyone in — it answers with sign_in_required —
      // because the login screen is where a second factor is asked for, and a link
      // that walked straight past it would be a way around MFA.
      const res = await apiFetch<TokenResponse & { sign_in_required?: boolean }>(
        "/auth/accept-invite",
        { method: "POST", body: { token, password: values.password }, auth: false, retry: false },
      );
      if (res.sign_in_required || !res.access_token) {
        setDone(true);
        return;
      }
      await signIn(res.access_token, res.user);
      navigate("/", { replace: true });
    } catch (err) {
      setFormError(err instanceof AppError ? err.message : "Could not accept the invitation.");
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Accept your invitation</CardTitle>
        <CardDescription>Set a password to activate your account</CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="space-y-4">
            <Alert>
              <AlertDescription>
                Your password has been changed, and every device that was signed in has
                been signed out. Sign in with the new password.
              </AlertDescription>
            </Alert>
            <Button className="w-full" onClick={() => navigate("/login", { replace: true })}>
              Go to sign in
            </Button>
          </div>
        ) : !token ? (
          <Alert variant="destructive">
            <AlertDescription>This invitation link is invalid or incomplete.</AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" autoComplete="new-password" {...register("password")} />
              {errors.password && <p className="text-sm text-destructive">{errors.password.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input id="confirm" type="password" autoComplete="new-password" {...register("confirm")} />
              {errors.confirm && <p className="text-sm text-destructive">{errors.confirm.message}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Activating…" : "Activate account"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
