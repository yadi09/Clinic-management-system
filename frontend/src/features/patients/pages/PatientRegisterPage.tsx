import { useState, type ReactNode } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

/** A date of birth N years before today, for a patient registered by age. */
function dobFromAge(years: number): string {
  const d = new Date();
  const y = d.getFullYear() - years;
  // 29 February has no birthday in most years; 28 February stands in.
  const day = d.getMonth() === 1 && d.getDate() === 29 ? 28 : d.getDate();
  return `${y}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

// One screen, built for the front desk (clinic feedback, 2026-10-01).
//
// It was a three-step wizard — Demographics, Contact & IDs, Review — for what is
// usually a name, a phone number and an age: two "Continue" presses before Save,
// the phone (which every SMS reminder needs) on page two, and blood group, which
// the desk almost never knows, given the same weight as the name. Now: the few
// things reception actually asks, in the order it asks them, and the rest behind
// "More details". Only the first name is required. The duplicate check is unchanged.
export function PatientRegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Most clinics register by age ("about 40"), so that is the default. A birthday,
  // when the patient knows it, is one click away (Ethiopian or Gregorian).
  const [dobMode, setDobMode] = useState<"age" | "date">("age");
  const [ageText, setAgeText] = useState("");
  const [more, setMore] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    watch,
    formState: { errors },
  } = useForm<PatientValues>({ resolver: zodResolver(patientSchema), defaultValues: { gender: "unknown", dob: "", dob_estimated: true } });
  const gender = watch("gender");

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

  const switchDob = (m: "age" | "date") => {
    setDobMode(m);
    // Switching clears the other way of saying it, so the record never carries an
    // age and a birthday that disagree.
    setAgeText("");
    setValue("dob", "");
    setValue("dob_estimated", m === "age");
  };

  const v = getValues();

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1>New patient</h1>
        <p className="text-sm text-muted-foreground">Only the first name is required — add whatever else the patient can tell you.</p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit((vals) => submit(vals, false))} className="space-y-6" noValidate>
            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}

            {/* Name: an Ethiopian name is the person's, their father's and their grandfather's. */}
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="First name" required error={errors.first_name?.message}>
                <Input autoFocus autoComplete="off" {...register("first_name")} />
              </Field>
              <Field label="Father's name">
                <Input autoComplete="off" {...register("middle_name")} />
              </Field>
              <Field label="Grandfather's name">
                <Input autoComplete="off" {...register("last_name")} />
              </Field>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Sex">
                <div className="flex gap-2" role="radiogroup" aria-label="Sex">
                  {(["male", "female"] as const).map((g) => (
                    <button key={g} type="button" role="radio" aria-checked={gender === g}
                      onClick={() => setValue("gender", gender === g ? "unknown" : g)}
                      className={cn("h-10 flex-1 rounded-md border text-sm font-medium capitalize transition-colors",
                        gender === g ? "border-brand bg-brand text-brand-foreground" : "hover:bg-muted")}>
                      {g}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label={dobMode === "age" ? "Age" : "Date of birth"} error={errors.dob?.message}>
                {dobMode === "age" ? (
                  <div className="flex items-center gap-2">
                    <Input inputMode="numeric" className="h-10 w-24 text-center text-base tabular-nums" placeholder="—" aria-label="Age in years"
                      value={ageText}
                      onChange={(e) => {
                        const t = e.target.value.replace(/\D/g, "").slice(0, 3);
                        setAgeText(t);
                        const n = Number(t);
                        setValue("dob", t !== "" && n <= 120 ? dobFromAge(n) : "");
                        setValue("dob_estimated", true);
                      }} />
                    <span className="text-sm text-muted-foreground">years</span>
                  </div>
                ) : (
                  <Controller
                    control={control}
                    name="dob"
                    render={({ field }) => <EthiopianDateInput value={field.value ?? ""} onChange={(val) => { field.onChange(val); setValue("dob_estimated", false); }} />}
                  />
                )}
                <button type="button" className="text-xs font-medium text-brand underline-offset-2 hover:underline"
                  onClick={() => switchDob(dobMode === "age" ? "date" : "age")}>
                  {dobMode === "age" ? "Knows their date of birth? Enter it instead" : "Use age in years instead"}
                </button>
                {dobMode === "age" && Number(ageText) > 120 && <p className="text-sm text-destructive">An age above 120 is not possible.</p>}
              </Field>
            </div>

            <Field label="Phone">
              <Input inputMode="tel" autoComplete="off" placeholder="09…" className="sm:max-w-xs" {...register("phone")} />
            </Field>

            {/* What the desk rarely knows, out of the way until it does. */}
            <div className="rounded-md border">
              <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
                className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium">
                More details <span className="font-normal text-muted-foreground">blood group · national ID · passport · email</span>
                <ChevronDown className={cn("h-4 w-4 transition-transform", more && "rotate-180")} />
              </button>
              {more && (
                <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
                  <Field label="Blood group">
                    <Controller control={control} name="blood_group" render={({ field }) => (
                      <Select value={field.value || "none"} onValueChange={(x) => field.onChange(x === "none" ? "" : x)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not known</SelectItem>
                          {BLOOD_GROUPS.map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )} />
                  </Field>
                  <Field label="National ID">
                    <Input {...register("national_id")} />
                  </Field>
                  <Field label="Passport no.">
                    <Input {...register("passport_no")} />
                  </Field>
                  <Field label="Email" error={errors.email?.message}>
                    <Input type="email" {...register("email")} />
                  </Field>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t pt-5">
              <Button type="button" variant="ghost" onClick={() => navigate("/patients")}>Cancel</Button>
              <Button type="submit" loading={submitting} disabled={dobMode === "age" && Number(ageText) > 120}>
                <UserPlus /> Register patient
              </Button>
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
              <DupRow label={v.dob_estimated ? "Age" : "Date of birth"} value={v.dob ? (v.dob_estimated ? `${ageText} years (age given)` : v.dob) : undefined} />
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

