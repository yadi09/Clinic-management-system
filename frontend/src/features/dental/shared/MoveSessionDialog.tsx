// Moving a dental treatment session to another day — the one dialog for it.
//
// Three screens let someone change a session's date (the patient schedule, the
// dentist's workspace, the reception view) and each had grown its own copy, so
// the same act warned about a past date on one screen and silently accepted it
// on another. The person doing the rescheduling is usually the same front-desk
// clerk; the answer should not depend on which page they happened to open.
//
// The desk may change WHEN a session happens, never what the session is: this
// dialog sends a date and nothing else, which is what lets reception hold
// appointment.manage without gaining any write access to the clinical record.
//
// The dialog never fetches. Only the schedule page knows what else is already
// booked that day, so the clash check arrives as an injected `clashes` callback:
// callers that have the data get the warning, callers that don't still work.
import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { AppError } from "@/lib/api-client";
import { EthiopianDateInput } from "@/components/EthiopianDateInput";
import { formatEthiopian } from "@/lib/ethiopian";
import { rescheduleSession } from "@/features/dental/api";

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayISO = () => isoOf(new Date());
const dayDiff = (iso: string, from = todayISO()) =>
  Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000);
// Weekday included: the desk reasons about which days the clinic is open.
const fmtShort = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** "in 15 days" / "15 days ago" / "today" — relative time is what people reason in. */
const relative = (iso: string) => {
  const d = dayDiff(iso);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${Math.abs(d)} days ago`;
};

/** The offsets a clerk actually reaches for; the full picker covers the rest. */
const PRESETS: readonly (readonly [string, number])[] = [
  ["Today", 0], ["In 3 days", 3], ["Next week", 7], ["In 2 weeks", 14], ["Next month", 30],
];

/** Something already booked on the candidate day, as the caller sees it. */
export interface SessionClash {
  id: string;
  label: string;
  /** A session that already happened can't be moved, so say so rather than imply a conflict. */
  done?: boolean;
}

export interface MoveSessionDialogProps {
  patientId: string;
  sessionId: string;
  /** The plan this session belongs to — what the user recognises it by. */
  planTitle: string;
  currentDate: string; // YYYY-MM-DD
  /** Free-text second line. Falls back to "Session N of M" when seq/sessionCount are given. */
  detail?: string;
  seq?: number;
  sessionCount?: number;
  /** Already overdue — worth restating, since it explains why the dialog is open. */
  missed?: boolean;
  /** Other sessions on a candidate day, excluding this one. Omit when unknown. */
  clashes?: (iso: string) => SessionClash[];
  onClose: () => void;
  onMoved: () => void;
}

/**
 * Move a planned session. Quick offsets cover the common cases; the full picker
 * (with its Ethiopian mode) is there when the patient names a specific day.
 *
 * Every check here warns and none of them block — a past date is how you record
 * a visit that already happened, and two sessions in one day is a legitimate
 * choice when the patient is having both treatments in one sitting.
 */
export function MoveSessionDialog({
  patientId, sessionId, planTitle, currentDate, detail, seq, sessionCount, missed, clashes, onClose, onMoved,
}: MoveSessionDialogProps) {
  const dateId = useId();
  const [date, setDate] = useState(currentDate);
  // The picker holds its own draft Ethiopian y/m/d while being typed into, so a
  // preset has to remount it to be reflected.
  const [pickerKey, setPickerKey] = useState(0);
  const plus = (days: number) => {
    const d = new Date(`${todayISO()}T00:00:00`);
    d.setDate(d.getDate() + days);
    setDate(isoOf(d));
    setPickerKey((k) => k + 1);
  };

  const mut = useMutation({
    mutationFn: () => rescheduleSession(patientId, sessionId, date),
    onSuccess: () => {
      toast.success(seq ? `Session ${seq} moved to ${fmtShort(date)}` : `Moved to ${fmtShort(date)}`);
      onMoved();
      onClose();
    },
    onError: (e) => toast.error(e instanceof AppError ? e.message : "Could not move this session"),
  });

  const line = detail ?? (seq && sessionCount ? `Session ${seq} of ${sessionCount}` : seq ? `Session ${seq}` : "");
  // An empty date means the picker holds a half-typed Ethiopian date, not a choice.
  const moved = !!date && date !== currentDate;
  const past = !!date && date < todayISO();
  const clash = date && clashes ? clashes(date) : [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{seq ? `Reschedule visit ${seq}` : "Reschedule visit"}</DialogTitle>
        </DialogHeader>

        <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
          <div className="font-medium">{planTitle}</div>
          <div className="text-xs text-muted-foreground">
            {line && <>{line} · </>}currently {fmtShort(currentDate)} ({formatEthiopian(currentDate)} EC)
            {missed && <span className="ml-1 font-medium text-rose-600">· missed {relative(currentDate)}</span>}
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          This changes the date only — the procedure, notes, prescription and amount stay
          exactly as the dentist set them.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor={dateId}>Move to</Label>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(([label, days]) => (
              <button key={label} type="button" onClick={() => plus(days)}
                className="rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent">
                {label}
              </button>
            ))}
          </div>
        </div>

        <EthiopianDateInput key={pickerKey} id={dateId} value={date} onChange={setDate} showAge={false} />

        {past && (
          <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            That date is in the past. Fine if you're recording when the visit actually happened —
            otherwise pick a future date so it shows as upcoming.
          </p>
        )}

        {clash.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <p className="flex items-start gap-2 font-medium">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {clash.length === 1 ? "There is already a session that day" : `There are already ${clash.length} sessions that day`}
            </p>
            <ul className="mt-1 space-y-0.5 pl-[1.4rem]">
              {clash.map((c) => <li key={c.id}>{c.label}{c.done ? " (done)" : ""}</li>)}
            </ul>
            <p className="mt-1 pl-[1.4rem]">Fine if the patient is having both in one visit — allow enough chair time.</p>
          </div>
        )}

        {moved && !past && clash.length === 0 && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            New date: {fmtDay(date)} · {formatEthiopian(date)} EC · {relative(date)}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!moved} loading={mut.isPending} onClick={() => mut.mutate()}>
            <CalendarClock className="h-4 w-4" /> Move session
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
