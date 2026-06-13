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
import { inviteUser, listRoles, listUsers, updateUserStatus, type InviteResult } from "@/features/admin/api";

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

  const users = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });

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
                {canUpdate && <TableHead>Actions</TableHead>}
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
                  {canUpdate && (
                    <TableCell>
                      {u.status === "active" ? (
                        <button className="text-xs text-destructive hover:underline" onClick={() => statusMut.mutate({ id: u.id, status: "suspended" })}>
                          Suspend
                        </button>
                      ) : u.status === "suspended" ? (
                        <button className="text-xs text-primary hover:underline" onClick={() => statusMut.mutate({ id: u.id, status: "active" })}>
                          Reactivate
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
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
