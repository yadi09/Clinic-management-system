import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/app/auth-context";
import {
  addAllergy,
  addCondition,
  getPatient,
  removeAllergy,
  removeCondition,
} from "@/features/patients/api";

export function PatientProfilePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const editable = can("patient.update");

  const { data, isLoading, isError } = useQuery({ queryKey: ["patient", id], queryFn: () => getPatient(id) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["patient", id] });

  const [allergyOpen, setAllergyOpen] = useState(false);
  const [conditionOpen, setConditionOpen] = useState(false);

  if (isLoading) return <p className="text-muted-foreground">Loading patient…</p>;
  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Patient not found</AlertTitle>
        <AlertDescription>
          <button className="underline" onClick={() => navigate("/patients")}>
            Back to patients
          </button>
        </AlertDescription>
      </Alert>
    );
  }

  const fullName = [data.first_name, data.middle_name, data.last_name].filter(Boolean).join(" ");

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{fullName}</h1>
          <p className="text-sm text-muted-foreground">
            MRN <span className="font-mono">{data.mrn}</span> · {data.gender} · DOB {data.dob}
          </p>
        </div>
        {data.allergies.length > 0 && (
          <Badge variant="destructive">{data.allergies.length} allergy alert(s)</Badge>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Demographics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Phone" value={data.phone} />
            <Row label="Email" value={data.email} />
            <Row label="National ID" value={data.national_id} />
            <Row label="Passport" value={data.passport_no} />
            <Row label="Blood group" value={data.blood_group} />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Allergies</CardTitle>
            {editable && (
              <Button size="sm" variant="outline" onClick={() => setAllergyOpen(true)}>
                Add
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {data.allergies.length === 0 ? (
              <p className="text-sm text-muted-foreground">No known allergies.</p>
            ) : (
              <ul className="space-y-2">
                {data.allergies.map((a) => (
                  <li key={a.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                    <span>
                      <span className="font-medium">{a.substance}</span>
                      {a.reaction ? ` — ${a.reaction}` : ""}{" "}
                      <Badge variant={a.severity === "severe" ? "destructive" : "secondary"}>{a.severity}</Badge>
                    </span>
                    {editable && (
                      <button
                        className="text-xs text-destructive hover:underline"
                        onClick={() => removeAllergy(id, a.id).then(invalidate)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Conditions</CardTitle>
            {editable && (
              <Button size="sm" variant="outline" onClick={() => setConditionOpen(true)}>
                Add
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {data.conditions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recorded conditions.</p>
            ) : (
              <ul className="space-y-2">
                {data.conditions.map((c) => (
                  <li key={c.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
                    <span>
                      <span className="font-medium">{c.description}</span>
                      {c.icd_code ? ` (${c.icd_code})` : ""} <Badge variant="outline">{c.status}</Badge>
                    </span>
                    {editable && (
                      <button
                        className="text-xs text-destructive hover:underline"
                        onClick={() => removeCondition(id, c.id).then(invalidate)}
                      >
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <AllergyModal open={allergyOpen} onClose={() => setAllergyOpen(false)} patientId={id} onSaved={invalidate} />
      <ConditionModal open={conditionOpen} onClose={() => setConditionOpen(false)} patientId={id} onSaved={invalidate} />
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value || "—"}</span>
    </div>
  );
}

function AllergyModal({ open, onClose, patientId, onSaved }: { open: boolean; onClose: () => void; patientId: string; onSaved: () => void }) {
  const [substance, setSubstance] = useState("");
  const [reaction, setReaction] = useState("");
  const [severity, setSeverity] = useState("mild");
  const mut = useMutation({
    mutationFn: () => addAllergy(patientId, { substance, reaction, severity }),
    onSuccess: () => {
      setSubstance("");
      setReaction("");
      setSeverity("mild");
      onSaved();
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Add allergy">
      <div className="space-y-3">
        <div className="space-y-2">
          <Label>Substance</Label>
          <Input value={substance} onChange={(e) => setSubstance(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Reaction</Label>
          <Input value={reaction} onChange={(e) => setReaction(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Severity</Label>
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="mild">Mild</option>
            <option value="moderate">Moderate</option>
            <option value="severe">Severe</option>
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!substance || mut.isPending} onClick={() => mut.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ConditionModal({ open, onClose, patientId, onSaved }: { open: boolean; onClose: () => void; patientId: string; onSaved: () => void }) {
  const [description, setDescription] = useState("");
  const [icd, setIcd] = useState("");
  const [status, setStatus] = useState("active");
  const mut = useMutation({
    mutationFn: () => addCondition(patientId, { description, icd_code: icd, status }),
    onSuccess: () => {
      setDescription("");
      setIcd("");
      setStatus("active");
      onSaved();
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title="Add condition">
      <div className="space-y-3">
        <div className="space-y-2">
          <Label>Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>ICD-10 code</Label>
          <Input value={icd} onChange={(e) => setIcd(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
            <option value="inactive">Inactive</option>
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!description || mut.isPending} onClick={() => mut.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
