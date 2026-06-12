import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAuth } from "@/app/auth-context";
import { AppError } from "@/lib/api-client";
import {
  inviteUser,
  listRoles,
  listUsers,
  updateUserStatus,
  type InviteResult,
} from "@/features/admin/api";

export function UsersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canInvite = can("user.invite");
  const canUpdate = can("user.update");

  const users = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const roles = useQuery({ queryKey: ["roles"], queryFn: listRoles });
  const [inviteOpen, setInviteOpen] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateUserStatus(id, status),
    onSuccess: invalidate,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
        {canInvite && <Button onClick={() => setInviteOpen(true)}>Invite user</Button>}
      </div>

      <Card>
        {users.isLoading ? (
          <p className="p-6 text-muted-foreground">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Email</th>
                <th className="p-3 font-medium">Roles</th>
                <th className="p-3 font-medium">Status</th>
                {canUpdate && <th className="p-3 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="p-3 font-medium">{u.full_name}</td>
                  <td className="p-3 text-muted-foreground">{u.email}</td>
                  <td className="p-3">{u.roles.join(", ") || "—"}</td>
                  <td className="p-3">
                    <Badge variant={u.status === "active" ? "default" : u.status === "invited" ? "secondary" : "destructive"}>
                      {u.status}
                    </Badge>
                  </td>
                  {canUpdate && (
                    <td className="p-3">
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
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        roles={(roles.data ?? []).map((r) => ({ code: r.code, name: r.name }))}
        onInvited={invalidate}
      />
    </div>
  );
}

function InviteModal({
  open,
  onClose,
  roles,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  roles: { code: string; name: string }[];
  onInvited: () => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => inviteUser({ email, full_name: fullName, roles: selected }),
    onSuccess: (res) => {
      setResult(res);
      setEmail("");
      setFullName("");
      setSelected([]);
      onInvited();
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => setError(e instanceof AppError ? e.message : "Could not invite user."),
  });

  const toggle = (code: string) =>
    setSelected((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));

  const close = () => {
    setResult(null);
    setError(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Invite staff">
      {result ? (
        <div className="space-y-3">
          <Alert>
            <AlertDescription>
              Invitation created for <strong>{result.email}</strong>. Share this link (email delivery is configured later):
            </AlertDescription>
          </Alert>
          <Input readOnly value={result.invite_link} onFocus={(e) => e.currentTarget.select()} />
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Full name</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Roles</Label>
            <div className="flex flex-wrap gap-2">
              {roles.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => toggle(r.code)}
                  className={
                    "rounded-full border px-3 py-1 text-xs " +
                    (selected.includes(r.code) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground")
                  }
                >
                  {r.name}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button disabled={!email || !fullName || mut.isPending} onClick={() => mut.mutate()}>
              Send invite
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
