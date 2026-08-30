// One clinic's whole story: how to reach them, where they are in the campaign,
// every call and visit, and the button that moves them on.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, PhoneCall, X } from "lucide-react";

import {
  completePhase, enrolProspect, getProspect, listCampaigns, listReps, logTouch,
  reopenProspect, setOutcome, assignProspect, type Prospect,
} from "@/features/platform/api";
import { ContactActions, StatusChip, TOUCH_LABEL, ago } from "@/features/platform/crm/shared";

const F = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";
const BTN = "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium";
const GHOST = `${BTN} border border-zinc-700 text-zinc-200 hover:bg-zinc-800`;
const SOLID = `${BTN} bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50`;

export function ProspectDialog({ id, canAdmin, onClose }: { id: string; canAdmin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["crm-prospect", id], queryFn: () => getProspect(id) });
  const campaigns = useQuery({ queryKey: ["crm-campaigns"], queryFn: listCampaigns });
  const reps = useQuery({ queryKey: ["crm-reps"], queryFn: listReps });
  const [err, setErr] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["crm-prospect", id] });
    qc.invalidateQueries({ queryKey: ["crm-board"] });
    qc.invalidateQueries({ queryKey: ["crm-prospects"] });
  };
  const run = <T,>(fn: () => Promise<T>) =>
    fn().then(refresh).catch((e: Error) => setErr(e.message));

  const p = q.data?.prospect;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 p-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-white">{p?.clinic_name ?? "…"}</h2>
            {p && (
              <p className="mt-0.5 text-sm text-zinc-400">
                {[p.contact_name, p.contact_role].filter(Boolean).join(" · ") || "no contact recorded"}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 text-zinc-500 hover:text-zinc-200"><X className="h-5 w-5" /></button>
        </div>

        {err && <p className="border-b border-rose-900/50 bg-rose-950/40 px-5 py-2 text-sm text-rose-300">{err}</p>}
        {!p ? <p className="p-5 text-sm text-zinc-500">Loading…</p> : (
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={p.status} />
              {p.campaign_name && (
                <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300">
                  {p.campaign_name} · phase {p.phase_seq} of {p.phase_count}
                </span>
              )}
              {p.owner_name && <span className="text-xs text-zinc-500">owner {p.owner_name}</span>}
            </div>

            <ContactActions p={p} size="md" />
            {p.address && <p className="text-sm text-zinc-400">{p.address}</p>}
            {p.note && <p className="rounded-md bg-zinc-800/60 p-3 text-sm text-zinc-300">{p.note}</p>}

            {/* Where they are, and the one button that moves them. */}
            {p.status === "open" && (
              <div className="rounded-lg border border-zinc-700 p-4">
                {p.phase_name ? (
                  <>
                    <p className="text-xs uppercase tracking-wide text-zinc-500">Standing on</p>
                    <p className="mt-0.5 text-base font-semibold text-white">{p.phase_name}</p>
                    <PhaseAction id={id} onErr={setErr} onDone={refresh} last={p.phase_seq === p.phase_count} />
                  </>
                ) : (
                  <Enrol id={id} campaigns={campaigns.data ?? []} onDone={refresh} onErr={setErr} />
                )}
              </div>
            )}

            {p.status !== "open" && (
              <div className="rounded-lg border border-zinc-700 p-4">
                <p className="text-sm text-zinc-300">
                  {p.status === "signed_up" && "Signed up."}
                  {p.status === "not_yet" && `Not yet — come back on ${p.ready_on}.`}
                  {p.status === "not_interested" && "Not interested."}
                  {p.outcome_note ? ` ${p.outcome_note}` : ""}
                </p>
                <button className={`${GHOST} mt-3`} onClick={() => run(() => reopenProspect(id))}>Put back in the pipeline</button>
              </div>
            )}

            <LogTouch id={id} onDone={refresh} onErr={setErr} />

            {canAdmin && (
              <div>
                <p className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Owner</p>
                <select className={F} value={p.owner_id ?? ""}
                  onChange={(e) => run(() => assignProspect(id, e.target.value))}>
                  <option value="">Nobody</option>
                  {(reps.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.full_name || r.email}</option>)}
                </select>
              </div>
            )}

            {/* What has actually happened, newest first. */}
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Contact history</p>
              {(q.data?.touches ?? []).length === 0 ? (
                <p className="text-sm text-zinc-600">Nobody has contacted this clinic yet.</p>
              ) : (
                <ul className="space-y-2">
                  {q.data!.touches.map((t) => (
                    <li key={t.id} className="rounded-md border border-zinc-800 p-2.5">
                      <p className="text-sm text-zinc-200">
                        {TOUCH_LABEL[t.kind] ?? t.kind}
                        <span className="text-zinc-500"> · {ago(t.happened_at)}{t.by_name ? ` · ${t.by_name}` : ""}</span>
                      </p>
                      {t.note && <p className="mt-0.5 text-sm text-zinc-400">{t.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {(q.data?.steps ?? []).length > 0 && (
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Steps completed</p>
                <ul className="space-y-1">
                  {q.data!.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-zinc-300">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      <span>
                        {s.phase_name}
                        <span className="text-zinc-500"> · {ago(s.done_at)}{s.done_by ? ` · ${s.done_by}` : ""}</span>
                        {s.note && <span className="block text-zinc-400">{s.note}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Marking a step done, with room for what happened. On the last phase it asks for
 *  the outcome instead of assuming one: finishing the steps and winning the clinic
 *  are different facts. */
function PhaseAction({ id, last, onDone, onErr }: {
  id: string; last: boolean; onDone: () => void; onErr: (s: string) => void;
}) {
  const [note, setNote] = useState("");
  const [outcome, setOutcome_] = useState(false);
  const m = useMutation({
    mutationFn: () => completePhase(id, note || undefined),
    onSuccess: () => { setNote(""); onDone(); },
    onError: (e: Error) => onErr(e.message),
  });
  if (outcome) return <OutcomeForm id={id} onDone={() => { setOutcome_(false); onDone(); }} onErr={onErr} />;
  return (
    <div className="mt-3 space-y-2">
      <input className={F} placeholder="What happened? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <button className={SOLID} disabled={m.isPending} onClick={() => m.mutate()}>
          <ArrowRight className="h-4 w-4" /> {last ? "Finish the last step" : "Done — next phase"}
        </button>
        <button className={GHOST} onClick={() => setOutcome_(true)}>Record the outcome</button>
      </div>
    </div>
  );
}

function OutcomeForm({ id, onDone, onErr }: { id: string; onDone: () => void; onErr: (s: string) => void }) {
  const [status, setStatus] = useState("signed_up");
  const [readyOn, setReadyOn] = useState("");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => setOutcome(id, { status, ready_on: readyOn || undefined, note: note || undefined }),
    onSuccess: onDone,
    onError: (e: Error) => onErr(e.message),
  });
  return (
    <div className="mt-3 space-y-2">
      <select className={F} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="signed_up">Signed up — they are a customer</option>
        <option value="not_yet">Not yet — come back later</option>
        <option value="not_interested">Not interested</option>
      </select>
      {status === "not_yet" && (
        <div>
          <input type="date" className={F} value={readyOn} onChange={(e) => setReadyOn(e.target.value)} />
          <p className="mt-1 text-xs text-zinc-500">Without a date this is the same as a no.</p>
        </div>
      )}
      <input className={F} placeholder="Anything worth remembering" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className={SOLID} disabled={m.isPending} onClick={() => m.mutate()}>Save the outcome</button>
    </div>
  );
}

function Enrol({ id, campaigns, onDone, onErr }: {
  id: string; campaigns: { id: string; name: string; is_active: boolean }[];
  onDone: () => void; onErr: (s: string) => void;
}) {
  const [cid, setCid] = useState("");
  const m = useMutation({
    mutationFn: () => enrolProspect(id, cid),
    onSuccess: onDone,
    onError: (e: Error) => onErr(e.message),
  });
  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-400">Not in a campaign. Put them in one to start the steps.</p>
      <select className={F} value={cid} onChange={(e) => setCid(e.target.value)}>
        <option value="">Choose a campaign…</option>
        {campaigns.filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button className={SOLID} disabled={!cid || m.isPending} onClick={() => m.mutate()}>Add to campaign</button>
    </div>
  );
}

function LogTouch({ id, onDone, onErr }: { id: string; onDone: () => void; onErr: (s: string) => void }) {
  const [kind, setKind] = useState("call");
  const [note, setNote] = useState("");
  const m = useMutation({
    mutationFn: () => logTouch(id, { kind, note: note || undefined }),
    onSuccess: () => { setNote(""); onDone(); },
    onError: (e: Error) => onErr(e.message),
  });
  return (
    <div className="rounded-lg border border-zinc-700 p-4">
      <p className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500">
        <PhoneCall className="h-3.5 w-3.5" /> Log a contact
      </p>
      <div className="flex flex-wrap gap-2">
        {["call", "visit", "message", "note"].map((k) => (
          <button key={k} onClick={() => setKind(k)}
            className={`rounded-md px-2.5 py-1 text-xs capitalize ${kind === k ? "bg-zinc-100 text-zinc-900" : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"}`}>
            {k}
          </button>
        ))}
      </div>
      <input className={`${F} mt-2`} placeholder="What was said?" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className={`${SOLID} mt-2`} disabled={m.isPending} onClick={() => m.mutate()}>Save</button>
    </div>
  );
}

export type { Prospect };
