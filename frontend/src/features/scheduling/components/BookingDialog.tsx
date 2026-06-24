import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { useDebounce } from "@/hooks/useDebounce";
import { searchPatients } from "@/features/patients/api";
import { listDepartments, listProviders } from "@/features/admin/api";
import { bookAppointment, rescheduleAppointment, type Appointment } from "@/features/scheduling/api";

const DURATIONS = [15, 20, 30, 45, 60];

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  branchId: string;
  defaultDate: string; // yyyy-mm-dd
  existing?: Appointment | null;
  onSaved: () => void;
}

export function BookingDialog({ open, onOpenChange, branchId, defaultDate, existing, onSaved }: Props) {
  const qc = useQueryClient();
  const editing = !!existing;

  const [patient, setPatient] = useState<{ id: string; name: string } | null>(null);
  const [provider, setProvider] = useState("");
  const [department, setDepartment] = useState("");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("09:00");
  const [duration, setDuration] = useState(30);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const providers = useQuery({ queryKey: ["providers"], queryFn: listProviders, enabled: open });
  const departments = useQuery({ queryKey: ["departments"], queryFn: listDepartments, enabled: open });

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (existing) {
      setPatient({ id: existing.patient_id, name: existing.patient_name });
      setProvider(existing.provider_id);
      setDepartment(existing.department_id ?? "");
      const s = new Date(existing.starts_at);
      setDate(s.toISOString().slice(0, 10));
      setTime(s.toTimeString().slice(0, 5));
      setDuration(Math.max(5, Math.round((new Date(existing.ends_at).getTime() - s.getTime()) / 60000)));
      setReason(existing.reason ?? "");
    } else {
      setPatient(null);
      setProvider("");
      setDepartment("");
      setDate(defaultDate);
      setTime("09:00");
      setDuration(30);
      setReason("");
    }
  }, [open, existing, defaultDate]);

  const mut = useMutation({
    mutationFn: async () => {
      const startsAt = new Date(`${date}T${time}`).toISOString();
      if (editing && existing) {
        return rescheduleAppointment(existing.id, {
          provider_id: provider,
          department_id: department || undefined,
          starts_at: startsAt,
          duration_min: duration,
          reason: reason || undefined,
        });
      }
      return bookAppointment({
        branch_id: branchId,
        patient_id: patient!.id,
        provider_id: provider,
        department_id: department || undefined,
        starts_at: startsAt,
        duration_min: duration,
        reason: reason || undefined,
      });
    },
    onSuccess: () => {
      toast.success(editing ? "Appointment updated" : "Appointment booked");
      qc.invalidateQueries({ queryKey: ["appointments"] });
      onSaved();
      onOpenChange(false);
    },
    onError: (e) => setError(e instanceof AppError ? e.message : "Could not save the appointment."),
  });

  const ready = (editing || patient) && provider && date && time;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Reschedule appointment" : "Book appointment"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1.5">
            <Label>Patient</Label>
            {editing ? (
              <Input value={patient?.name ?? ""} disabled />
            ) : (
              <PatientCombobox value={patient} onSelect={setPatient} />
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {(providers.data ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Department</Label>
              <Select value={department} onValueChange={setDepartment}>
                <SelectTrigger>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  {(departments.data ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Time</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Duration</Label>
              <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Chief complaint" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready} loading={mut.isPending} onClick={() => mut.mutate()}>
            {editing ? "Save changes" : "Book"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PatientCombobox({ value, onSelect }: { value: { id: string; name: string } | null; onSelect: (p: { id: string; name: string }) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const debounced = useDebounce(q, 250);
  const results = useQuery({
    queryKey: ["patients", debounced, 1],
    queryFn: () => searchPatients(debounced.trim(), 1, 8),
    enabled: open, // empty query returns the first patients, so a list shows by default
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          {value ? value.name : <span className="text-muted-foreground">Search patient…</span>}
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search by name / MRN / phone…" value={q} onValueChange={setQ} />
          <CommandList>
            <CommandEmpty>{results.isFetching ? "Loading…" : "No patients found."}</CommandEmpty>
            {(results.data?.items ?? []).map((p) => (
              <CommandItem
                key={p.id}
                value={p.id}
                onSelect={() => {
                  onSelect({ id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") });
                  setOpen(false);
                }}
              >
                <Check className={value?.id === p.id ? "opacity-100" : "opacity-0"} />
                <span>{[p.first_name, p.last_name].filter(Boolean).join(" ")}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{p.mrn}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
