import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { platformLogin, platformToken } from "@/features/platform/api";

export function PlatformLoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => platformLogin(email.trim(), password),
    onSuccess: () => navigate("/platform"),
    onError: (e) => setError(e instanceof Error ? e.message : "Login failed"),
  });

  // Already signed in → go straight to the console.
  if (platformToken.get()) {
    navigate("/platform");
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-100">
      <Card className="w-full max-w-sm space-y-5 border-zinc-800 bg-zinc-900 p-7">
        <div className="space-y-1 text-center">
          <ShieldCheck className="mx-auto h-7 w-7 text-emerald-400" />
          <h1 className="text-lg font-semibold">Platform Console</h1>
          <p className="text-xs text-zinc-400">Vendor super-admin — provision &amp; manage clinics</p>
        </div>
        {error && <div className="rounded-md bg-rose-950/60 px-3 py-2 text-sm text-rose-300">{error}</div>}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            mut.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label className="text-zinc-300">Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoFocus className="bg-zinc-800" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-zinc-300">Password</Label>
            <Input value={password} onChange={(e) => setPassword(e.target.value)} type="password" className="bg-zinc-800" />
          </div>
          <Button type="submit" className="w-full" disabled={!email || !password} loading={mut.isPending}>
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
