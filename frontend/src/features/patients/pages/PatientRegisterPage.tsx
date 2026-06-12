import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Modal } from "@/components/ui/modal";
import { AppError } from "@/lib/api-client";
import { createPatient, type Duplicate } from "@/features/patients/api";
import { patientSchema, type PatientValues } from "@/features/patients/schemas";

export function PatientRegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<PatientValues>({
    resolver: zodResolver(patientSchema),
    defaultValues: { gender: "unknown" },
  });

  const submit = async (values: PatientValues, force: boolean) => {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await createPatient(values, force);
      if (res.duplicates && res.duplicates.length > 0) {
        setDuplicates(res.duplicates);
        return;
      }
      if (res.patient) {
        qc.invalidateQueries({ queryKey: ["patients"] });
        navigate(`/patients/${res.patient.id}`, { replace: true });
      }
    } catch (err) {
      setFormError(err instanceof AppError ? err.message : "Could not register patient.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Register patient</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Patient details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit((v) => submit(v, false))} className="space-y-4" noValidate>
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="First name" error={errors.first_name?.message}>
                <Input {...register("first_name")} />
              </Field>
              <Field label="Middle name">
                <Input {...register("middle_name")} />
              </Field>
              <Field label="Last name" error={errors.last_name?.message}>
                <Input {...register("last_name")} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Gender">
                <Select {...register("gender")}>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                  <option value="unknown">Unknown</option>
                </Select>
              </Field>
              <Field label="Date of birth" error={errors.dob?.message}>
                <Input type="date" {...register("dob")} />
              </Field>
              <Field label="Blood group">
                <Input placeholder="O+" {...register("blood_group")} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone">
                <Input {...register("phone")} />
              </Field>
              <Field label="Email" error={errors.email?.message}>
                <Input type="email" {...register("email")} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="National ID">
                <Input {...register("national_id")} />
              </Field>
              <Field label="Passport no.">
                <Input {...register("passport_no")} />
              </Field>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => navigate("/patients")}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : "Register"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Modal open={!!duplicates} onClose={() => setDuplicates(null)} title="Possible duplicate patients">
        <p className="mb-3 text-sm text-muted-foreground">
          A patient with matching details may already exist. Review before continuing.
        </p>
        <ul className="mb-4 space-y-2">
          {duplicates?.map((d) => (
            <li key={d.id} className="rounded-md border p-3 text-sm">
              <div className="font-medium">{d.full_name}</div>
              <div className="text-muted-foreground">
                MRN {d.mrn} · DOB {d.dob}
                {d.phone ? ` · ${d.phone}` : ""}
              </div>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setDuplicates(null)}>
            Review
          </Button>
          <Button
            variant="destructive"
            disabled={submitting}
            onClick={() => {
              setDuplicates(null);
              void submit(getValues(), true);
            }}
          >
            Register anyway
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
