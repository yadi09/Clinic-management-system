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
import { AppError } from "@/lib/api-client";
import { verifyMfaApi } from "@/features/auth/api";
import { mfaSchema, type MfaValues } from "@/features/auth/schemas";

export function MfaPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);

  const state = location.state as { mfaToken?: string; from?: string } | null;
  const mfaToken = state?.mfaToken;
  const from = state?.from ?? "/";

  useEffect(() => {
    if (!mfaToken) navigate("/login", { replace: true });
  }, [mfaToken, navigate]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<MfaValues>({ resolver: zodResolver(mfaSchema) });

  const onSubmit = async (values: MfaValues) => {
    if (!mfaToken) return;
    setFormError(null);
    try {
      const res = await verifyMfaApi({ mfa_token: mfaToken, code: values.code });
      signIn(res.access_token, res.user);
      navigate(from, { replace: true });
    } catch (err) {
      setFormError(err instanceof AppError ? err.message : "Verification failed. Please try again.");
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>Enter the 6-digit code from your authenticator app</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="code">Authentication code</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              {...register("code")}
            />
            {errors.code && <p className="text-sm text-destructive">{errors.code.message}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Verifying…" : "Verify"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
