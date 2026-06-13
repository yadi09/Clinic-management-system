import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { useAuth } from "@/app/auth-context";
import {
  createBranch,
  createDepartment,
  getClinic,
  listBranches,
  listDepartments,
  saveClinic,
} from "@/features/admin/api";

export function SettingsPage() {
  const { can } = useAuth();
  const manage = can("clinic.manage");
  const qc = useQueryClient();

  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments });

  const [clinicName, setClinicName] = useState("");
  useEffect(() => {
    if (clinic.data?.name) setClinicName(clinic.data.name);
  }, [clinic.data?.name]);

  const saveClinicMut = useMutation({
    mutationFn: () => saveClinic({ name: clinicName }),
    onSuccess: () => {
      toast.success("Clinic profile saved");
      qc.invalidateQueries({ queryKey: ["clinic"] });
    },
  });

  const [branchName, setBranchName] = useState("");
  const [branchCode, setBranchCode] = useState("");
  const addBranchMut = useMutation({
    mutationFn: () => createBranch({ name: branchName, code: branchCode }),
    onSuccess: () => {
      toast.success("Branch added");
      setBranchName("");
      setBranchCode("");
      qc.invalidateQueries({ queryKey: ["branches"] });
    },
    onError: () => toast.error("Could not add branch (code may be taken)"),
  });

  const [deptName, setDeptName] = useState("");
  const [deptBranch, setDeptBranch] = useState("");
  const [deptSpecialty, setDeptSpecialty] = useState("");
  const addDeptMut = useMutation({
    mutationFn: () => createDepartment({ branch_id: deptBranch, name: deptName, specialty: deptSpecialty }),
    onSuccess: () => {
      toast.success("Department added");
      setDeptName("");
      setDeptSpecialty("");
      qc.invalidateQueries({ queryKey: ["departments"] });
    },
  });

  return (
    <div className="space-y-6">
      <h1>Clinic settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Clinic profile</CardTitle>
          <CardDescription>The clinic name shown across the workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex max-w-md items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label>Name</Label>
              <Input value={clinicName} onChange={(e) => setClinicName(e.target.value)} disabled={!manage} />
            </div>
            {manage && (
              <Button onClick={() => saveClinicMut.mutate()} disabled={!clinicName} loading={saveClinicMut.isPending}>
                Save
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Branches</CardTitle>
          <CardDescription>Physical locations of the clinic.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {(branches.data ?? []).map((b) => (
              <li key={b.id} className="flex items-center justify-between rounded-md border bg-background p-2.5 text-sm">
                <span>
                  <span className="font-medium">{b.name}</span>{" "}
                  <span className="font-mono text-xs text-muted-foreground">{b.code}</span>
                </span>
                <Badge variant={b.is_active ? "success" : "outline"}>{b.is_active ? "active" : "inactive"}</Badge>
              </li>
            ))}
            {branches.data?.length === 0 && <p className="text-sm text-muted-foreground">No branches yet.</p>}
          </ul>
          {manage && (
            <div className="flex flex-wrap items-end gap-3 border-t pt-4">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input value={branchCode} onChange={(e) => setBranchCode(e.target.value)} />
              </div>
              <Button onClick={() => addBranchMut.mutate()} disabled={!branchName || !branchCode} loading={addBranchMut.isPending}>
                <Plus /> Add branch
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Departments</CardTitle>
          <CardDescription>Specialty units within a branch.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {(departments.data ?? []).map((d) => (
              <li key={d.id} className="rounded-md border bg-background p-2.5 text-sm">
                <span className="font-medium">{d.name}</span>
                {d.specialty ? <span className="text-muted-foreground"> · {d.specialty}</span> : null}
              </li>
            ))}
            {departments.data?.length === 0 && <p className="text-sm text-muted-foreground">No departments yet.</p>}
          </ul>
          {manage && (branches.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-end gap-3 border-t pt-4">
              <div className="w-48 space-y-1.5">
                <Label>Branch</Label>
                <Select value={deptBranch} onValueChange={setDeptBranch}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(branches.data ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={deptName} onChange={(e) => setDeptName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Specialty</Label>
                <Input value={deptSpecialty} onChange={(e) => setDeptSpecialty(e.target.value)} />
              </div>
              <Button onClick={() => addDeptMut.mutate()} disabled={!deptBranch || !deptName} loading={addDeptMut.isPending}>
                <Plus /> Add department
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
