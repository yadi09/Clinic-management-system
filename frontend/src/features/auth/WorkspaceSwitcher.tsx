// Moving between a clinic's branches. Each branch is a workspace of its own — its own
// patients, notes, money and staff — so moving is a sign-in to that branch, and the app
// starts fresh there: nothing on screen from the branch being left can remain.
import { useState } from "react";
import { Building2, Check, ChevronsUpDown } from "lucide-react";

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { switchWorkspaceApi, type Workspace } from "@/features/auth/api";
import { tokenStore } from "@/lib/token";

/** Starts the app over at the home page. An object so tests can replace it. */
export const nav = { reloadHome: () => window.location.assign("/") };

export function useSwitchWorkspace() {
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (w: Workspace) => {
    if (w.current || busy) return;
    setBusy(w.id);
    try {
      const r = await switchWorkspaceApi(w.id);
      tokenStore.set(r.access_token);
      nav.reloadHome();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open that branch");
      setBusy(null);
    }
  };
  return { busy, go };
}

/** The switcher in the top bar (desktop). */
export function WorkspaceSwitcher({ items, role }: { items: Workspace[]; role: string }) {
  const { busy, go } = useSwitchWorkspace();
  const current = items.find((w) => w.current);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Switch branch" className="hidden items-center gap-2 rounded-md bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/15 focus:outline-none md:flex">
        <Building2 className="h-4 w-4" />
        <span className="max-w-[16rem] truncate">{busy ? "Opening…" : current?.name ?? "Branch"}</span>
        <span className="capitalize opacity-70">· {role}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Your branches</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <WorkspaceItems items={items} busy={busy} go={go} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same list as menu items, for the account menu on a phone. */
export function WorkspaceItems({ items, busy, go }: { items: Workspace[]; busy: string | null; go: (w: Workspace) => void }) {
  return (
    <>
      {items.map((w) => (
        <DropdownMenuItem key={w.id} disabled={!!busy} onSelect={() => go(w)}>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{w.name}</span>
            <span className="truncate text-xs text-muted-foreground">{w.slug}</span>
          </span>
          {w.current && <Check className="h-4 w-4" aria-label="current branch" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}
