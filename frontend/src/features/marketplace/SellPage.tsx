import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import {
  getMe, KINDS, login, sellerToken, signUp, type Seller, type SellerKind, type SignupInput,
} from "@/features/marketplace/api";
import { SellerPortal } from "@/features/marketplace/SellerPortal";

const opt = (on: boolean) =>
  "rounded-lg border px-3 py-2 text-sm transition-colors " + (on ? "border-primary bg-primary/10 font-semibold" : "bg-card hover:bg-accent");

/** /marketplace/sell — the door for sellers. Signed out: apply or sign in. Signed in: the portal. */
export function MarketSellPage() {
  const qc = useQueryClient();
  const [hasToken, setHasToken] = useState(!!sellerToken.get());
  const me = useQuery({
    queryKey: ["market-me"],
    queryFn: getMe,
    enabled: hasToken,
    retry: false,
  });

  const signedIn = (token: string, seller: Seller) => {
    sellerToken.set(token);
    qc.setQueryData(["market-me"], seller);
    setHasToken(true);
  };
  const signOut = () => {
    sellerToken.clear();
    qc.removeQueries({ queryKey: ["market-me"] });
    qc.removeQueries({ queryKey: ["market-my"] });
    setHasToken(false);
  };

  if (hasToken && me.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (hasToken && me.data) return <SellerPortal seller={me.data} onSignOut={signOut} />;
  // A stale token (expired, or the seller was suspended): fall through to the form.
  return <Door onIn={signedIn} stale={hasToken && me.isError} />;
}

function Door({ onIn, stale }: { onIn: (t: string, s: Seller) => void; stale: boolean }) {
  const [mode, setMode] = useState<"apply" | "login">("apply");
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Sell on the ClinicOS Marketplace</h1>
        <p className="text-sm text-muted-foreground">
          Suppliers, wholesalers and clinics can list new or used dental products. We call every new seller before their listings go public.
        </p>
      </div>
      {stale && <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">Please sign in again.</p>}
      <div className="flex gap-2">
        <button className={opt(mode === "apply")} onClick={() => setMode("apply")}>Become a seller</button>
        <button className={opt(mode === "login")} onClick={() => setMode("login")}>I already have an account</button>
      </div>
      {mode === "apply" ? <ApplyForm onIn={onIn} /> : <LoginForm onIn={onIn} />}
    </div>
  );
}

function LoginForm({ onIn }: { onIn: (t: string, s: Seller) => void }) {
  const [phone, setPhone] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="space-y-3 rounded-xl border bg-card p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try { const s = await login(phone, pw); onIn(s.token, s.seller); }
        catch (x) { setErr(x instanceof Error ? x.message : "Could not sign in"); }
        finally { setBusy(false); }
      }}
    >
      <div><Label htmlFor="lp">Phone</Label><Input id="lp" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09…" /></div>
      <div><Label htmlFor="lw">Password</Label><Input id="lw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" loading={busy} disabled={!phone || !pw}>Sign in</Button>
    </form>
  );
}

function ApplyForm({ onIn }: { onIn: (t: string, s: Seller) => void }) {
  const [f, setF] = useState<SignupInput>({
    kind: "supplier", name: "", phone: "", telegram: "", city: "", subcity: "", about: "", password: "", website: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof SignupInput>(k: K, v: SignupInput[K]) => setF((s) => ({ ...s, [k]: v }));
  const ok = f.name.trim() && f.phone.trim() && f.city.trim() && f.password.length >= 6;
  return (
    <form
      className="space-y-3 rounded-xl border bg-card p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true); setErr(null);
        try {
          const s = await signUp(f);
          toast.success("Application sent — we will call you");
          onIn(s.token, s.seller);
        } catch (x) { setErr(x instanceof Error ? x.message : "Could not send the application"); }
        finally { setBusy(false); }
      }}
    >
      <div>
        <Label>I am a *</Label>
        <div className="mt-1 flex flex-wrap gap-2">
          {KINDS.map((k) => (
            <button type="button" key={k.id} className={opt(f.kind === k.id)} onClick={() => set("kind", k.id as SellerKind)}>{k.label}</button>
          ))}
        </div>
      </div>
      <div><Label htmlFor="an">Name or business name *</Label><Input id="an" value={f.name} onChange={(e) => set("name", e.target.value)} /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label htmlFor="ap">Phone *</Label><Input id="ap" inputMode="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="09…" /></div>
        <div><Label htmlFor="at">Telegram</Label><Input id="at" value={f.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="@username" /></div>
        <div><Label htmlFor="ac">City *</Label><Input id="ac" value={f.city} onChange={(e) => set("city", e.target.value)} /></div>
        <div><Label htmlFor="as">Sub-city / area</Label><Input id="as" value={f.subcity} onChange={(e) => set("subcity", e.target.value)} /></div>
      </div>
      <div><Label htmlFor="ab">What do you sell?</Label><Textarea id="ab" rows={2} value={f.about} onChange={(e) => set("about", e.target.value)} /></div>
      <div><Label htmlFor="aw">Choose a password * <span className="font-normal text-muted-foreground">(at least 6 characters)</span></Label><Input id="aw" type="password" value={f.password} onChange={(e) => set("password", e.target.value)} /></div>
      {/* Honeypot: people never see it, bots fill it. */}
      <div aria-hidden className="absolute -left-[9999px]"><input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set("website", e.target.value)} /></div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      <Button type="submit" loading={busy} disabled={!ok}>Send application</Button>
    </form>
  );
}
