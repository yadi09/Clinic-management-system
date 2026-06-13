import { useState, type ReactNode } from "react";
import { useForm, Controller, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Stepper } from "@/components/ui/stepper";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AppError } from "@/lib/api-client";
import { toast } from "@/components/ui/sonner";
import { createPatient, type Duplicate } from "@/features/patients/api";
import { patientSchema, type PatientValues } from "@/features/patients/schemas";

const STEPS = ["Demographics", "Contact & IDs", "Review"];
const STEP_FIELDS: Path<PatientValues>[][] = [
  ["first_name", "middle_name", "last_name", "gender", "dob", "blood_group"],
  ["phone", "email", "national_id", "passport_no"],
  [],
];

export function PatientRegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    trigger,
    getValues,
    formState: { errors },
  } = useForm<PatientValues>({ resolver: zodResolver(patientSchema), defaultValues: { gender: "unknown" } });

  const next = async () => {
    if (await trigger(STEP_FIELDS[step])) setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

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
        toast.success(`Patient registered · ${res.patient.mrn}`);
        qc.invalidateQueries({ queryKey: ["patients"] });
        navigate(`/patients/${res.patient.id}`, { replace: true });
      }
    } catch (err) {
      setFormError(err instanceof AppError ? err.message : "Could not register patient.");
    } finally {
      setSubmitting(false);
    }
  };

  const v = getValues();

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1>Register patient</h1>
        <p className="text-sm text-muted-foreground">Step {step + 1} of {STEPS.length} · {STEPS[step]}</p>
      </div>

      <Stepper steps={STEPS} current={step} />

      <Card>
        <CardHeader>
          <CardTitle>{STEPS[step]}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit((vals) => submit(vals, false))} className="space-y-5" noValidate>
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            {step === 0 && (
              <div className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="First name" required error={errors.first_name?.message}>
                    <Input {...register("first_name")} />
                  </Field>
                  <Field label="Middle name">
                    <Input {...register("middle_name")} />
                  </Field>
                  <Field label="Last name" required error={errors.last_name?.message}>
                    <Input {...register("last_name")} />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Gender">
                    <Controller
                      control={control}
                      name="gender"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="male">Male</SelectItem>
                            <SelectItem value="female">Female</SelectItem>
                            <SelectItem value="other">Other</SelectItem>
                            <SelectItem value="unknown">Unknown</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </Field>
                  <Field label="Date of birth" required error={errors.dob?.message}>
                    <Input type="date" {...register("dob")} />
                  </Field>
                  <Field label="Blood group">
                    <Input placeholder="O+" {...register("blood_group")} />
                  </Field>
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-5">
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
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-md border bg-background p-4 text-sm sm:grid-cols-3">
                  <Review label="Name" value={[v.first_name, v.middle_name, v.last_name].filter(Boolean).join(" ")} />
                  <Review label="Gender" value={v.gender} />
                  <Review label="Date of birth" value={v.dob} />
                  <Review label="Phone" value={v.phone} />
                  <Review label="Email" value={v.email} />
                  <Review label="National ID" value={v.national_id} />
                </dl>
                <p className="text-sm text-muted-foreground">
                  Review the details above. Registration assigns a unique MRN and checks for possible duplicates.
                </p>
              </div>
            )}

            <div className="flex items-center justify-between border-t pt-5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => (step === 0 ? navigate("/patients") : setStep((s) => s - 1))}
              >
                {step === 0 ? "Cancel" : (<><ArrowLeft /> Back</>)}
              </Button>
              {step < STEPS.length - 1 ? (
                <Button type="button" onClick={next}>
                  Continue <ArrowRight />
                </Button>
              ) : (
                <Button type="submit" loading={submitting}>
                  <UserPlus /> Register patient
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Dialog open={!!duplicates} onOpenChange={(o) => !o && setDuplicates(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Possible duplicate patients</DialogTitle>
            <DialogDescription>A patient with matching details may already exist. Review before continuing.</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {duplicates?.map((d) => (
              <li key={d.id} className="rounded-md border p-3 text-sm">
                <div className="font-medium text-brand">{d.full_name}</div>
                <div className="text-muted-foreground">
                  MRN {d.mrn} · DOB {d.dob}
                  {d.phone ? ` · ${d.phone}` : ""}
                </div>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDuplicates(null)}>
              Review
            </Button>
            <Button
              variant="destructive"
              loading={submitting}
              onClick={() => {
                setDuplicates(null);
                void submit(getValues(), true);
              }}
            >
              Register anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label} {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function Review({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <dt className="text-label uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium capitalize">{value || "—"}</dd>
    </div>
  );
}
