import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import { AppError } from "@/lib/api-client";
import { assignRoles, inviteUser, listRoles, listUsers, updateUserStatus, type InviteResult, type UserListItem } from "@/features/admin/api";

function statusVariant(s: string): "success" | "warning" | "destructive" | "default" {
  if (s === "active") return "success";
  if (s === "invited") return "warning";
  if (s === "suspended" || s === "deactivated") return "destructive";
  return "default";
}

export function UsersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canInvite = can("user.invite");
  const canUpdate = can("user.update");
  const canAssign = can("role.assign");

  const users = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });
  const [editing, setEditing] = useState<UserListItem | null>(null);

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateUserStatus(id, status),
    onSuccess: () => {
      toast.success("Staff updated");
      invalidate();
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>Staff</h1>
          <p className="text-sm text-muted-foreground">{users.data?.length ?? 0} members</p>
        </div>
        {canInvite && <InviteDialog onInvited={invalidate} />}
      </div>

      <Card className="overflow-hidden">
        {users.isLoading ? (
          <div className="space-y-3 p-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Roles</TableHead>
                <TableHead>Status</TableHead>
                {(canUpdate || canAssign) && <TableHead>Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(users.data ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium text-brand">{u.full_name}</TableCell>
                  <TableCell className="text-muted-foreground">{u.email}</TableCell>
                  <TableCell className="capitalize">{u.roles.map((r) => r.replace(/_/g, " ")).join(", ") || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(u.status)}>{u.status}</Badge>
                  </TableCell>
                  {(canUpdate || canAssign) && (
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {canAssign && (
                          <button className="text-xs text-primary hover:underline" onClick={() => setEditing(u)}>
                            Edit roles
                          </button>
                        )}
                        {canUpdate && u.status === "active" && (
                          <button className="text-xs text-destructive hover:underline" onClick={() => statusMut.mutate({ id: u.id, status: "suspended" })}>
                            Suspend
                          </button>
                        )}
                        {canUpdate && u.status === "suspended" && (
                          <button className="text-xs text-primary hover:underline" onClick={() => statusMut.mutate({ id: u.id, status: "active" })}>
                            Reactivate
                          </button>
                        )}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <EditRolesDialog user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />
    </div>
  );
}

function EditRolesDialog({ user, onClose, onSaved }: { user: UserListItem | null; onClose: () => void; onSaved: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const roles = useQuery({ queryKey: ["roles"], queryFn: listRoles, enabled: !!user });
  // Reset selection whenever a different user is opened.
  const [forUser, setForUser] = useState<string | null>(null);
  if (user && forUser !== user.id) {
    setForUser(user.id);
    setSelected(user.roles);
  }
  const mut = useMutation({
    mutationFn: () => assignRoles(user!.id, selected),
    onSuccess: () => { toast.success("Roles updated"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update roles"),
  });
  const toggle = (code: string) => setSelected((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));
  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o) { setForUser(null); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit roles{user ? ` — ${user.full_name}` : ""}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          A role's permissions take effect the next time the user signs in (or their session refreshes).
          To let a receptionist collect cash, add the <span className="font-medium text-foreground">Cashier</span> role.
        </p>
        <div className="space-y-1.5">
          <Label>Roles</Label>
          <div className="flex flex-wrap gap-2">
            {(roles.data ?? []).map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => toggle(r.code)}
                className={
                  "rounded-full border px-3 py-1 text-xs capitalize transition-colors " +
                  (selected.includes(r.code) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")
                }
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setForUser(null); onClose(); }}>Cancel</Button>
          <Button disabled={selected.length === 0} loading={mut.isPending} onClick={() => mut.mutate()}>Save roles</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({ onInvited }: { onInvited: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roles = useQuery({ queryKey: ["roles"], queryFn: listRoles, enabled: open });

  const mut = useMutation({
    mutationFn: () => inviteUser({ email, full_name: fullName, roles: selected }),
    onSuccess: (res) => {
      setResult(res);
      setEmail("");
      setFullName("");
      setSelected([]);
      onInvited();
    },
    onError: (e) => setError(e instanceof AppError ? e.message : "Could not invite user."),
  });

  const toggle = (code: string) => setSelected((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));
  const close = () => {
    setResult(null);
    setError(null);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus /> Invite user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite staff</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="space-y-3">
            <Alert>
              <AlertDescription>
                Invitation created for <strong>{result.email}</strong>. Share this link (email delivery is configured in a later phase):
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Input readOnly value={result.invite_link} onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  void navigator.clipboard?.writeText(result.invite_link);
                  toast.success("Link copied");
                }}
              >
                <Copy />
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Roles</Label>
              <div className="flex flex-wrap gap-2">
                {(roles.data ?? []).map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => toggle(r.code)}
                    className={
                      "rounded-full border px-3 py-1 text-xs capitalize transition-colors " +
                      (selected.includes(r.code) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")
                    }
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={!email || !fullName} loading={mut.isPending} onClick={() => mut.mutate()}>
                Send invite
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
