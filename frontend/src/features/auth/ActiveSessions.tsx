// The devices this account is signed in on: what each is, where it signed in from,
// when it signed in and was last active, a name the user can give it, and a button to
// sign it out. Left yourself signed in on a shared or lost device? Sign it out here.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Monitor, Pencil, Smartphone, Tablet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { countryName, describeDevice, lastActive } from "@/features/auth/device";
import { labelSessionApi, listSessionsApi, revokeSessionApi, signOutOtherDevicesApi, type Device } from "@/features/auth/api";

const ICON = { phone: Smartphone, tablet: Tablet, computer: Monitor };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const say = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function ActiveSessions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sessions"], queryFn: listSessionsApi, refetchOnWindowFocus: true });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const signOut = useMutation({
    mutationFn: (d: Device) => revokeSessionApi(d.id),
    onSuccess: (_r, d) => { const i = describeDevice(d.user_agent); toast.success(`Signed out ${d.label || `${i.browser} on ${i.os}`}`); refresh(); },
    onError: (e) => { toast.error(say(e, "Could not sign that device out")); refresh(); },
  });
  const signOutAll = useMutation({
    mutationFn: signOutOtherDevicesApi,
    onSuccess: (r) => { toast.success(r.revoked > 0 ? `Signed out ${r.revoked} other device${r.revoked === 1 ? "" : "s"}` : "No other devices were signed in"); refresh(); },
    onError: (e) => toast.error(say(e, "Could not sign out other devices")),
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; text: string }) => labelSessionApi(v.id, v.text),
    onSuccess: () => { setEditing(null); refresh(); },
    onError: (e) => toast.error(say(e, "Could not save the name")),
  });

  // This device first, so "which one is me?" is the first thing the list answers.
  const devices = [...(q.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current));
  const others = devices.filter((d) => !d.current).length;

  return (
    <div className="space-y-3">
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading your devices…</p>}
      {q.isError && <p role="alert" className="text-sm text-destructive">Could not load your devices.{" "}
        <button type="button" className="underline" onClick={() => { void q.refetch(); }}>Try again</button></p>}
      <ul className="divide-y rounded-lg border">
        {devices.map((d) => {
          const i = describeDevice(d.user_agent), Icon = ICON[i.kind], where = [d.ip, countryName(d.country)].filter(Boolean).join(" · ");
          const edit = editing?.id === d.id ? editing : null;
          return (
            <li key={d.id} aria-current={d.current ? "true" : undefined}
              className={`flex flex-wrap items-start gap-3 p-3 sm:flex-nowrap ${d.current ? "border-l-4 border-l-brand bg-brand/5" : ""}`}>
              <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {d.label && <span>{d.label} <span className="font-normal text-muted-foreground">({i.browser} on {i.os})</span></span>}
                  {!d.label && <span>{i.browser} on {i.os}</span>}
                  {d.current && <><Badge variant="success">This device</Badge><span className="text-xs font-normal text-brand">You are here</span></>}
                </div>
                <p className="text-xs text-muted-foreground">Signed in {when(d.started_at)} · {d.current ? "Active now" : lastActive(d.last_active)}</p>
                {where && <p className="text-xs text-muted-foreground">{where}</p>}
                {edit ? (
                  <form className="flex max-w-sm items-center gap-2 pt-1" onSubmit={(e) => { e.preventDefault(); rename.mutate(edit); }}>
                    <Input aria-label="Device name" autoFocus maxLength={60} value={edit.text} placeholder="e.g. Reception PC"
                      onChange={(e) => setEditing({ id: d.id, text: e.target.value })} />
                    <Button type="submit" size="sm" loading={rename.isPending}>Save</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </form>
                ) : (
                  <button type="button" className="inline-flex items-center gap-1 pt-0.5 text-xs text-brand hover:underline"
                    onClick={() => setEditing({ id: d.id, text: d.label })}>
                    <Pencil className="h-3 w-3" aria-hidden /> {d.label ? "Rename" : "Name this device"}
                  </button>
                )}
              </div>
              {!d.current && (
                <Button variant="outline" size="sm" onClick={() => signOut.mutate(d)} loading={signOut.isPending && signOut.variables?.id === d.id}>
                  Sign out
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {others > 0 && (
        <Button variant="outline" onClick={() => signOutAll.mutate()} loading={signOutAll.isPending}>
          Sign out all other devices
        </Button>
      )}
      {q.isSuccess && others === 0 && <p className="text-xs text-muted-foreground">You are signed in on this device only.</p>}
    </div>
  );
}
