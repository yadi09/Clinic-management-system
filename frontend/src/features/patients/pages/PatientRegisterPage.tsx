import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
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
import { Badge } from "@/components/ui/badge";
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
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { cn } from "@/lib/utils";
import { formatEthiopian } from "@/lib/ethiopian";

const STEPS = ["Demographics", "Contact & IDs", "Review"];
const STEP_FIELDS: Path<PatientValues>[][] = [
  ["first_name", "middle_name", "last_name", "gender", "dob", "blood_group"],
  ["phone", "email", "national_id", "passport_no"],
  [],
];

/** A date of birth N years before today, for a patient registered by age. */
function dobFromAge(years: number): string {
  const d = new Date();
  const y = d.getFullYear() - years;
  // 29 February has no birthday in most years; 28 February stands in.
  const day = d.getMonth() === 1 && d.getDate() === 29 ? 28 : d.getDate();
  return `${y}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function PatientRegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const typed = useSearchParams()[0].get("name") ?? "";
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Most clinics register by age ("about 40"), so that is the default. A birthday,
  // when the patient knows it, is one click away (Ethiopian or Gregorian).
  const [dobMode, setDobMode] = useState<"age" | "date">("age");
  const [ageText, setAgeText] = useState("");

  const {
    register,
    handleSubmit,
    control,
    trigger,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<PatientValues>({
    resolver: zodResolver(patientSchema),
    // A name typed into a search that found nobody arrives here, so the desk does not
    // type it twice: first word is the first name, the rest the last.
    defaultValues: { gender: "unknown", dob: "", dob_estimated: true, ...typedName(typed) },
  });

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
          {/* Never auto-submit: registration only fires from the explicit Review-step
              button below, so Enter in a field can't skip the review. */}
          <form onSubmit={(e) => e.preventDefault()} className="space-y-5" noValidate>
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
                  <Field label="Last name" error={errors.last_name?.message}>
                    <Input {...register("last_name")} />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
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
                  <Field label="Blood group">
                    <Input placeholder="O+" {...register("blood_group")} />
                  </Field>
                </div>
                <Field label={dobMode === "age" ? "Age" : "Date of birth"} error={errors.dob?.message}>
                  <div className="space-y-2">
                    <div className="inline-flex rounded-md border p-0.5 text-sm" role="tablist" aria-label="Age or date of birth">
                      {(["age", "date"] as const).map((m) => (
                        <button key={m} type="button" role="tab" aria-selected={dobMode === m}
                          className={cn("rounded px-3 py-1", dobMode === m ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:bg-muted")}
                          onClick={() => {
                            setDobMode(m);
                            // Switching clears the other way of saying it, so the
                            // record never carries an age and a birthday that disagree.
                            setAgeText("");
                            setValue("dob", "", { shouldValidate: false });
                            setValue("dob_estimated", m === "age");
                          }}>
                          {m === "age" ? "Age in years" : "Date of birth"}
                        </button>
                      ))}
                    </div>
                    {dobMode === "age" ? (
                      <div className="flex items-center gap-2">
                        <Input inputMode="numeric" className="w-28" placeholder="e.g. 40" aria-label="Age in years"
                          value={ageText}
                          onChange={(e) => {
                            const t = e.target.value.replace(/\D/g, "").slice(0, 3);
                            setAgeText(t);
                            const n = Number(t);
                            const ok = t !== "" && n >= 0 && n <= 120;
                            setValue("dob", ok ? dobFromAge(n) : "", { shouldValidate: t !== "" });
                            setValue("dob_estimated", true);
                          }} />
                        <span className="text-sm text-muted-foreground">years old</span>
                      </div>
                    ) : (
                      <Controller
                        control={control}
                        name="dob"
                        render={({ field }) => <EthiopianDateInput value={field.value ?? ""} onChange={(v) => { field.onChange(v); setValue("dob_estimated", false); }} />}
                      />
                    )}
                  </div>
                </Field>
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
                  <Review label={v.dob_estimated ? "Age" : "Date of birth"}
                    value={v.dob ? (v.dob_estimated ? `${ageText} years (age given)` : `${v.dob} · ${formatEthiopian(v.dob)} EC`) : undefined} />
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
                <Button type="button" loading={submitting} onClick={handleSubmit((vals) => submit(vals, false))}>
                  <UserPlus /> Register patient
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Dialog open={!!duplicates} onOpenChange={(o) => !o && setDuplicates(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Possible duplicate — is this the same patient?</DialogTitle>
            <DialogDescription>
              Someone with matching details already exists. Compare the person in front of you with the existing record.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 md:grid-cols-2">
            {/* The person being registered now */}
            <div className="rounded-lg border-2 border-primary/50 bg-primary/5 p-3">
              <Badge className="mb-2">New — registering now</Badge>
              <DupRow label="Name" value={[v.first_name, v.middle_name, v.last_name].filter(Boolean).join(" ")} />
              <DupRow label="Date of birth" value={v.dob} />
              <DupRow label="Phone" value={v.phone} />
              <DupRow label="Email" value={v.email} />
            </div>

            {/* Existing matching record(s) */}
            <div className="space-y-3">
              {duplicates?.map((d) => {
                const samePhone = !!v.phone && v.phone === d.phone;
                const sameDob = !!v.dob && v.dob === d.dob;
                return (
                  <div key={d.id} className="rounded-lg border p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <Badge variant="outline">Existing patient</Badge>
                      <button
                        type="button"
                        className="text-xs font-medium text-primary hover:underline"
                        onClick={() => { setDuplicates(null); navigate(`/patients/${d.id}`); }}
                      >
                        Open record →
                      </button>
                    </div>
                    <DupRow label="Name" value={d.full_name} />
                    <DupRow label="MRN" value={d.mrn} mono />
                    <DupRow label="Date of birth" value={d.dob} highlight={sameDob} />
                    <DupRow label="Phone" value={d.phone} highlight={samePhone} />
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Highlighted fields match the new entry. If it's the same person, open their record instead of creating a duplicate —
            only register a new patient if these are genuinely different people.
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDuplicates(null)}>
              Back to edit
            </Button>
            <Button
              variant="destructive"
              loading={submitting}
              onClick={() => {
                setDuplicates(null);
                void submit(getValues(), true);
              }}
            >
              Different person — register new
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

function DupRow({ label, value, mono, highlight }: { label: string; value?: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`text-right font-medium ${mono ? "font-mono text-xs" : ""} ${highlight ? "rounded bg-amber-100 px-1.5 text-amber-800" : ""}`}>
        {value || "—"}
      </span>
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

/** "Abeba Kebede Tola" typed into search becomes first "Abeba", last "Kebede Tola". */
function typedName(raw: string): { first_name?: string; last_name?: string } {
  const [first, ...rest] = raw.trim().split(/\s+/).filter(Boolean);
  if (!first) return {};
  return rest.length ? { first_name: first, last_name: rest.join(" ") } : { first_name: first };
}
