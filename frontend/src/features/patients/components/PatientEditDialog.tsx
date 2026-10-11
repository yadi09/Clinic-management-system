// Edit a patient's personal details. Shared by the general profile and the dental
// workspace so the front desk can correct a name, phone or birthdate from wherever
// they happen to be — gated on patient.update by the caller.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { updatePatient, type Patient } from "@/features/patients/api";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const NONE = "__none";

export function PatientEditDialog({ patient, onClose, onSaved }: {
  patient: Patient;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    first_name: patient.first_name ?? "",
    middle_name: patient.middle_name ?? "",
    last_name: patient.last_name ?? "",
    gender: patient.gender || "unknown",
    dob: patient.dob ?? "",
    phone: patient.phone ?? "",
    email: patient.email ?? "",
    national_id: patient.national_id ?? "",
    blood_group: patient.blood_group ?? "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const mut = useMutation({
    mutationFn: () => updatePatient(patient.id, {
      first_name: f.first_name.trim(),
      middle_name: f.middle_name.trim(),
      last_name: f.last_name.trim(),
      gender: f.gender,
      dob: f.dob,
      phone: f.phone.trim(),
      email: f.email.trim(),
      national_id: f.national_id.trim(),
      blood_group: f.blood_group,
      // What this form does not show is handed back exactly as it was loaded: saving a
      // new phone number must not erase the passport, address or emergency contact
      // (PAT-6). Absent ones are left out, and the server then keeps what it holds.
      ...(patient.passport_no ? { passport_no: patient.passport_no } : {}),
      ...(patient.address != null ? { address: patient.address } : {}),
      ...(patient.emergency_contact != null ? { emergency_contact: patient.emergency_contact } : {}),
    }),
    onSuccess: () => { toast.success("Patient details updated"); onSaved(); onClose(); },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not save the changes"),
  });

  // Only the first name is required, as at registration.
  const valid = f.first_name.trim();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Edit patient details</DialogTitle></DialogHeader>
        <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5"><Label>First name *</Label><Input value={f.first_name} onChange={(e) => set("first_name", e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Middle name</Label><Input value={f.middle_name} onChange={(e) => set("middle_name", e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Last name</Label><Input value={f.last_name} onChange={(e) => set("last_name", e.target.value)} /></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Sex</Label>
              <Select value={f.gender} onValueChange={(v) => set("gender", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="male">Male</SelectItem>
                  <SelectItem value="female">Female</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Blood group</Label>
              <Select value={f.blood_group || NONE} onValueChange={(v) => set("blood_group", v === NONE ? "" : v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not recorded</SelectItem>
                  {BLOOD_GROUPS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5"><Label>Date of birth</Label><EthiopianDateInput value={f.dob} onChange={(v) => set("dob", v)} /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Phone</Label><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="09…" /></div>
            <div className="space-y-1.5"><Label>Email</Label><Input type="email" value={f.email} onChange={(e) => set("email", e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>National ID</Label><Input value={f.national_id} onChange={(e) => set("national_id", e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} loading={mut.isPending} onClick={() => mut.mutate()}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
