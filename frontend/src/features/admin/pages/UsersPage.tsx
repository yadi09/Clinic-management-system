import { useEffect, useState } from "react";
import { roleOffered } from "@/features/admin/roles";
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
import { assignRoles, deleteUser, inviteUser, issueResetLink, listRoles, listUsers, updateUserProfile, updateUserStatus, type InviteResult, type UserListItem } from "@/features/admin/api";

/** The server is the authority (kernel/phone); this only catches an obvious slip
 *  before a round-trip. Empty is allowed — the field is optional. */
function phoneProblem(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const d = t.replace(/\D/g, "");
  if (d.length < 7) return "That looks too short for a phone number.";
  return null;
}

/** Whether an SMS could actually reach this number today. Safaricom (07…) and
 *  landlines are real numbers our gateway will not carry, so say so rather than
 *  letting someone assume a code could be texted there later. */
function smsNote(raw: string): string | null {
  const d = raw.replace(/\D/g, "").replace(/^251/, "0").replace(/^(9|7)(?=\d{8}$)/, "0$1");
  if (d.length !== 10 || !d.startsWith("0")) return null;
  if (d.startsWith("09")) return null;
  if (d.startsWith("07")) return "Safaricom numbers can be called but can't receive our texts yet.";
  return "This looks like a landline — fine for calling, but it can't receive texts.";
}

/** A stored number, shown the way staff read it: 0911 22 33 44. */
function prettyPhone(p: string): string {
  return /^0\d{9}$/.test(p) ? `${p.slice(0, 4)} ${p.slice(4, 6)} ${p.slice(6, 8)} ${p.slice(8)}` : p;
}

function statusVariant(s: string): "success" | "warning" | "destructive" | "default" {
  if (s === "active") return "success";
  if (s === "invited") return "warning";
  if (s === "suspended" || s === "deactivated") return "destructive";
  return "default";
}

export function UsersPage() {
  const { can, user: me } = useAuth();
  const qc = useQueryClient();
  const canInvite = can("user.invite");
  const [reset, setReset] = useState<{ user: UserListItem; link: string } | null>(null);
  const canUpdate = can("user.update");
  const canAssign = can("role.assign");

  const users = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["users"] });
  const [editing, setEditing] = useState<UserListItem | null>(null);
  const [renaming, setRenaming] = useState<UserListItem | null>(null);
  const [deleting, setDeleting] = useState<UserListItem | null>(null);

  const resetMut = useMutation({
    mutationFn: (u: UserListItem) => issueResetLink(u.id).then((r) => ({ u, r })),
    onSuccess: ({ u, r }) => setReset({ user: u, link: r.invite_link }),
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not create a reset link"),
  });

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => updateUserStatus(id, status),
    onSuccess: () => {
      toast.success("Staff updated");
      invalidate();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      toast.success("Staff member removed");
      setDeleting(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove the staff member"),
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
                <TableHead>Phone</TableHead>
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
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {u.phone ? (
                      <a className="hover:underline" href={`tel:${u.phone}`}>{prettyPhone(u.phone)}</a>
                    ) : canUpdate ? (
                      <button className="text-xs text-primary hover:underline" onClick={() => setRenaming(u)}>Add</button>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="capitalize">{u.roles.map((r) => r.replace(/_/g, " ")).join(", ") || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(u.status)}>{u.status}</Badge>
                  </TableCell>
                  {(canUpdate || canAssign) && (
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {canUpdate && (
                          <button className="text-xs text-primary hover:underline" onClick={() => setRenaming(u)}>
                            Edit details
                          </button>
                        )}
                        {canAssign && (
                          <button className="text-xs text-primary hover:underline" onClick={() => setEditing(u)}>
                            Edit roles
                          </button>
                        )}
                        {/* A forgotten password had no way out: the invitation has
                            been used, and nothing could issue another. */}
                        {canInvite && u.status !== "suspended" && (
                          <button className="text-xs text-primary hover:underline"
                            onClick={() => resetMut.mutate(u)}>
                            {resetMut.isPending && resetMut.variables?.id === u.id ? "Working…" : "Reset password"}
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
                        {canUpdate && u.id !== me?.id && (
                          <button className="text-xs text-destructive hover:underline" onClick={() => setDeleting(u)}>
                            Delete
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

      <EditDetailsDialog user={renaming} onClose={() => setRenaming(null)} onSaved={() => { setRenaming(null); invalidate(); }} />
      <EditRolesDialog user={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />

      {/* The link, once. It is not stored anywhere it can be read again, and the
          previous one stopped working the moment this was issued. */}
      <Dialog open={!!reset} onOpenChange={(o) => !o && setReset(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Password reset link</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Give this to <span className="font-medium text-foreground">{reset?.user.full_name}</span>{" "}
              ({reset?.user.email}). It works once, expires in 12 hours, and any link issued
              to them before now has stopped working.
            </p>
            {/* Whoever you hand it to can set this password, so check you are
                handing it to the right person before you send it anywhere. */}
            {reset?.user.phone ? (
              <p className="text-sm">
                Reach them on{" "}
                <a className="font-medium hover:underline" href={`tel:${reset.user.phone}`}>{prettyPhone(reset.user.phone)}</a>
                <span className="text-muted-foreground"> — confirm it's them before sending it.</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No phone on their record, so there is no way to check it is really them asking. Hand it
                over in person, and add their number while you are at it.
              </p>
            )}
            <Input readOnly value={reset?.link ?? ""} onFocus={(e) => e.currentTarget.select()} />
            <p className="text-xs text-muted-foreground">
              When they set the new password they will be signed out of every device and
              asked to sign in again — so if somebody else had their account open, they lose it.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReset(null)}>Close</Button>
            <Button onClick={() => {
              if (reset) void navigator.clipboard?.writeText(reset.link);
              toast.success("Link copied");
            }}>Copy link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Remove staff member</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            Remove <span className="font-medium text-foreground">{deleting?.full_name}</span> ({deleting?.email})? They'll be signed out and lose access. You can re-invite them later.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" loading={deleteMut.isPending} onClick={() => deleting && deleteMut.mutate(deleting.id)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EditDetailsDialog({ user, onClose, onSaved }: { user: UserListItem | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [tel, setTel] = useState("");
  const [forUser, setForUser] = useState<string | null>(null);
  // Seed the fields whenever a different user is opened.
  if (user && forUser !== user.id) {
    setForUser(user.id);
    setName(user.full_name);
    setTel(user.phone ?? "");
  }
  const problem = phoneProblem(tel);
  const note = problem ? null : smsNote(tel);
  const changed = !!user && (name.trim() !== user.full_name || tel.trim() !== (user.phone ?? ""));
  const mut = useMutation({
    mutationFn: () => updateUserProfile(user!.id, name.trim(), tel.trim()),
    onSuccess: () => { toast.success("Staff details updated"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the changes"),
  });
  const save = () => { if (changed && name.trim() && !problem) mut.mutate(); };
  return (
    <Dialog open={!!user} onOpenChange={(o) => { if (!o) { setForUser(null); onClose(); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit details{user ? ` — ${user.email}` : ""}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Full name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          </div>
          <div className="space-y-1.5">
            <Label>Phone</Label>
            <Input value={tel} onChange={(e) => setTel(e.target.value)} placeholder="09…" onKeyDown={(e) => e.key === "Enter" && save()} />
            {problem ? (
              <p className="text-xs text-destructive">{problem}</p>
            ) : note ? (
              <p className="text-xs text-warning">{note}</p>
            ) : (
              <p className="text-xs text-muted-foreground">How the clinic reaches this person. Clearing it is allowed.</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setForUser(null); onClose(); }}>Cancel</Button>
          <Button disabled={!name.trim() || !!problem || !changed} loading={mut.isPending} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditRolesDialog({ user, onClose, onSaved }: { user: UserListItem | null; onClose: () => void; onSaved: () => void }) {
  const { branches, flagOn } = useAuth();
  const [selected, setSelected] = useState<string[]>([]);
  const [branchSel, setBranchSel] = useState<string[]>([]);
  const roles = useQuery({ queryKey: ["roles"], queryFn: listRoles, enabled: !!user });
  // Reset selection whenever a different user is opened.
  const [forUser, setForUser] = useState<string | null>(null);
  if (user && forUser !== user.id) {
    setForUser(user.id);
    setSelected(user.roles);
    setBranchSel([]);
  }
  const mut = useMutation({
    mutationFn: () => assignRoles(user!.id, selected, branchSel),
    onSuccess: () => { toast.success("Roles updated"); onSaved(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not update roles"),
  });
  const toggle = (code: string) => setSelected((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));
  const toggleBranch = (id: string) => setBranchSel((s) => (s.includes(id) ? s.filter((b) => b !== id) : [...s, id]));
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
            {(roles.data ?? []).filter((r) => roleOffered(r.code, flagOn, user?.roles.includes(r.code))).map((r) => (
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
        {branches.length > 1 && (
          <div className="space-y-1.5">
            <Label>Branches</Label>
            <p className="text-xs text-muted-foreground">Which branches this staff member works in. Leave empty for all branches.</p>
            <div className="flex flex-wrap gap-2">
              {branches.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => toggleBranch(b.id)}
                  className={"rounded-full border px-3 py-1 text-xs transition-colors " + (branchSel.includes(b.id) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}
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
  const [tel, setTel] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roles = useQuery({ queryKey: ["roles"], queryFn: listRoles, enabled: open });
  const { branches, activeBranchId, flagOn } = useAuth();
  const [branchSel, setBranchSel] = useState<string[]>([]);
  // Default new staff to the branch the admin is currently working in.
  useEffect(() => {
    if (open) setBranchSel(activeBranchId && branches.length > 1 ? [activeBranchId] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mut = useMutation({
    mutationFn: () => inviteUser({ email, full_name: fullName, phone: tel.trim(), roles: selected, branch_ids: branchSel }),
    onSuccess: (res) => {
      setResult(res);
      setEmail("");
      setFullName("");
      setTel("");
      setSelected([]);
      setBranchSel([]);
      onInvited();
    },
    onError: (e) => setError(e instanceof AppError ? e.message : "Could not invite user."),
  });

  const toggle = (code: string) => setSelected((s) => (s.includes(code) ? s.filter((c) => c !== code) : [...s, code]));
  const toggleBranch = (id: string) => setBranchSel((s) => (s.includes(id) ? s.filter((b) => b !== id) : [...s, id]));
  const invitePhoneProblem = phoneProblem(tel);
  const inviteSmsNote = invitePhoneProblem ? null : smsNote(tel);
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
              <Label>Phone</Label>
              <Input value={tel} onChange={(e) => setTel(e.target.value)} placeholder="09…" />
              {/* Asked for here because filling it in later never happens, and
                  without it a forgotten password can only be answered by handing
                  over a link in person. */}
              {invitePhoneProblem ? (
                <p className="text-xs text-destructive">{invitePhoneProblem}</p>
              ) : inviteSmsNote ? (
                <p className="text-xs text-warning">{inviteSmsNote}</p>
              ) : (
                <p className="text-xs text-muted-foreground">How the clinic reaches this person off email.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Roles</Label>
              <div className="flex flex-wrap gap-2">
                {(roles.data ?? []).filter((r) => roleOffered(r.code, flagOn)).map((r) => (
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
            {branches.length > 1 && (
              <div className="space-y-1.5">
                <Label>Branches</Label>
                <p className="text-xs text-muted-foreground">Which branches this staff member works in. Leave empty for all branches.</p>
                <div className="flex flex-wrap gap-2">
                  {branches.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggleBranch(b.id)}
                      className={"rounded-full border px-3 py-1 text-xs transition-colors " + (branchSel.includes(b.id) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={!email || !fullName || !!invitePhoneProblem} loading={mut.isPending} onClick={() => mut.mutate()}>
                Send invite
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
