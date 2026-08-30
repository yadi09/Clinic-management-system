// The three screens a marketing team actually uses: the board they work from, the
// list they search, and the accounts an admin manages.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Plus, Search, Users } from "lucide-react";

import {
  checkDuplicates, createCampaign, createProspect, createRep, getBoard, importInbound,
  listCampaigns, listProspects, listReps, setCampaignActive, setRepStatus, updateCampaign,
  type Campaign, type PhaseDraft, type Prospect,
} from "@/features/platform/api";
import { ContactActions, LastTouch, StatusChip } from "@/features/platform/crm/shared";
import { ProspectDialog } from "@/features/platform/crm/ProspectDialog";

const F = "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none";
const BTN = "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium";
const GHOST = `${BTN} border border-zinc-700 text-zinc-200 hover:bg-zinc-800`;
const SOLID = `${BTN} bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50`;

/* ------------------------------------------------------------- the board */

/**
 * The pipeline, one column per phase.
 *
 * A card carries only what decides the next action: who they are, the number to
 * ring, the way there, and when anyone last spoke to them. Everything else is one
 * click away rather than crowding the column.
 */
export function PipelineView({ canAdmin }: { canAdmin: boolean }) {
  const campaigns = useQuery({ queryKey: ["crm-campaigns"], queryFn: listCampaigns });
  const [cid, setCid] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);
  const [designing, setDesigning] = useState<Campaign | "new" | null>(null);
  const active = cid || campaigns.data?.find((c) => c.is_active)?.id || campaigns.data?.[0]?.id || "";
  const board = useQuery({ queryKey: ["crm-board", active], queryFn: () => getBoard(active), enabled: !!active });

  if (campaigns.isLoading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if ((campaigns.data ?? []).length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-700 p-10 text-center">
        <p className="text-zinc-300">No campaigns yet.</p>
        <p className="mt-1 text-sm text-zinc-500">A campaign is the set of steps a clinic goes through — first visit, demo, decision.</p>
        {canAdmin && <button className={`${SOLID} mt-4`} onClick={() => setDesigning("new")}><Plus className="h-4 w-4" /> Design the first campaign</button>}
        {designing && <CampaignDialog campaign={null} onClose={() => setDesigning(null)} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className={`${F} max-w-xs`} value={active} onChange={(e) => setCid(e.target.value)}>
          {campaigns.data!.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.is_active ? "" : " (paused)"}</option>
          ))}
        </select>
        {canAdmin && (
          <>
            <button className={GHOST} onClick={() => setDesigning(campaigns.data!.find((c) => c.id === active) ?? "new")}>Edit phases</button>
            <button className={GHOST} onClick={() => setDesigning("new")}><Plus className="h-4 w-4" /> New campaign</button>
            <ImportInbound campaignId={active} />
          </>
        )}
      </div>

      {board.isLoading ? <p className="text-sm text-zinc-500">Loading…</p> : (
        <div className="flex gap-3 overflow-x-auto pb-3">
          {(board.data?.columns ?? []).map((col) => (
            <section key={col.phase.id} className="w-72 shrink-0">
              <header className="mb-2">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold text-white">{col.phase.seq}. {col.phase.name}</h3>
                  <span className="text-xs text-zinc-500">{col.prospects.length}</span>
                </div>
                {col.phase.intent && <p className="text-[11px] text-zinc-500">{col.phase.intent}</p>}
              </header>
              <div className="space-y-2">
                {col.prospects.length === 0 && (
                  <p className="rounded-md border border-dashed border-zinc-800 p-3 text-center text-xs text-zinc-600">Nobody here</p>
                )}
                {col.prospects.map((p) => (
                  <button key={p.id} onClick={() => setOpen(p.id)}
                    className="block w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-left hover:border-zinc-600">
                    <p className="truncate text-sm font-medium text-white">{p.clinic_name}</p>
                    {p.contact_name && <p className="truncate text-xs text-zinc-400">{p.contact_name}</p>}
                    <div className="mt-2"><ContactActions p={p} /></div>
                    <div className="mt-2"><LastTouch p={p} /></div>
                    {p.owner_name && <p className="mt-1 text-[11px] text-zinc-600">{p.owner_name}</p>}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {open && <ProspectDialog id={open} canAdmin={canAdmin} onClose={() => setOpen(null)} />}
      {designing && (
        <CampaignDialog campaign={designing === "new" ? null : designing} onClose={() => setDesigning(null)} />
      )}
    </div>
  );
}

function ImportInbound({ campaignId }: { campaignId: string }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  const m = useMutation({
    mutationFn: () => importInbound(campaignId || undefined),
    onSuccess: (r) => {
      setMsg(r.imported === 0 ? "Nothing new from the website" : `${r.imported} brought in`);
      qc.invalidateQueries({ queryKey: ["crm-board"] });
      qc.invalidateQueries({ queryKey: ["crm-prospects"] });
    },
    onError: (e: Error) => setMsg(e.message),
  });
  return (
    <div className="flex items-center gap-2">
      <button className={GHOST} disabled={m.isPending} onClick={() => m.mutate()}>
        <Download className="h-4 w-4" /> Bring in website enquiries
      </button>
      {msg && <span className="text-xs text-zinc-500">{msg}</span>}
    </div>
  );
}

/* -------------------------------------------------------------- the list */

/** A "not yet" whose day has come. Recording the date was the easy half; putting the
 *  clinic back in front of somebody on the day is what makes it worth recording. */
const isDue = (p: Prospect) =>
  p.status === "not_yet" && !!p.ready_on && p.ready_on <= new Date().toISOString().slice(0, 10);

export function ProspectsView({ canAdmin }: { canAdmin: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [owner, setOwner] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const reps = useQuery({ queryKey: ["crm-reps"], queryFn: listReps });
  const list = useQuery({ queryKey: ["crm-prospects", q, status, owner], queryFn: () => listProspects(q, status, owner) });
  const due = useMemo(() => (list.data ?? []).filter(isDue), [list.data]);
  const rows = dueOnly ? due : (list.data ?? []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-600" />
          <input className={`${F} pl-9`} placeholder="Clinic, contact, phone or area…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={`${F} max-w-[11rem]`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Every status</option>
          <option value="open">Working</option>
          <option value="signed_up">Signed up</option>
          <option value="not_yet">Not yet</option>
          <option value="not_interested">Not interested</option>
        </select>
        <select className={`${F} max-w-[12rem]`} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">Everyone</option>
          {(reps.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.full_name || r.email}</option>)}
        </select>
        <button className={SOLID} onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add a clinic</button>
      </div>

      {due.length > 0 && (
        <button onClick={() => setDueOnly((d) => !d)}
          className={`flex w-full items-center gap-2 rounded-lg border p-3 text-left text-sm ${
            dueOnly ? "border-amber-500 bg-amber-950/40 text-amber-200" : "border-amber-600/40 bg-amber-950/20 text-amber-300 hover:border-amber-500"}`}>
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {due.length} clinic{due.length === 1 ? "" : "s"} said to come back by now.
          <span className="ml-auto text-xs opacity-80">{dueOnly ? "show everyone" : "show them"}</span>
        </button>
      )}

      {list.isLoading ? <p className="text-sm text-zinc-500">Loading…</p> : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-700 p-10 text-center text-sm text-zinc-500">
          No clinics match. Add the ones your team collected today.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((p) => (
            <button key={p.id} onClick={() => setOpen(p.id)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-left hover:border-zinc-600">
              <div className="min-w-[12rem] flex-1">
                <p className="truncate text-sm font-medium text-white">{p.clinic_name}</p>
                <p className="truncate text-xs text-zinc-500">
                  {[p.contact_name, p.address].filter(Boolean).join(" · ") || "no contact yet"}
                </p>
              </div>
              <ContactActions p={p} />
              <div className="min-w-[10rem]"><LastTouch p={p} /></div>
              <div className="flex items-center gap-2">
                <StatusChip status={p.status} />
                {isDue(p) && (
                  <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                    chase now · said {p.ready_on}
                  </span>
                )}
                {p.phase_name && <span className="text-xs text-zinc-500">{p.phase_name}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {open && <ProspectDialog id={open} canAdmin={canAdmin} onClose={() => setOpen(null)} />}
      {adding && <AddProspect onClose={() => setAdding(false)} />}
    </div>
  );
}

/**
 * Adding a clinic, with the duplicate check where it belongs — while the rep is
 * still typing, not after they have entered everything.
 */
function AddProspect({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const campaigns = useQuery({ queryKey: ["crm-campaigns"], queryFn: listCampaigns });
  const [f, setF] = useState<Record<string, string>>({ clinic_name: "", contact_name: "", contact_role: "", phone: "", address: "", map_url: "", note: "", campaign_id: "" });
  const [err, setErr] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  const dupes = useQuery({
    queryKey: ["crm-dupes", f.clinic_name, f.phone],
    queryFn: () => checkDuplicates(f.clinic_name, f.phone),
    enabled: f.clinic_name.length > 2 || f.phone.length > 5,
  });

  const m = useMutation({
    mutationFn: () => createProspect(Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crm-prospects"] });
      qc.invalidateQueries({ queryKey: ["crm-board"] });
      onClose();
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="mt-10 w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white">Add a clinic</h2>
        <p className="mt-0.5 text-sm text-zinc-500">What you need to go back: a name, someone to ask for, a number and where it is.</p>

        {(dupes.data ?? []).length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-600/40 bg-amber-950/30 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-amber-300">
              <AlertTriangle className="h-4 w-4" /> Somebody may already have this one
            </p>
            {dupes.data!.map((d) => (
              <p key={d.id} className="mt-1 text-xs text-amber-200/80">
                {d.clinic_name} — {d.why}{d.owner_name ? `, with ${d.owner_name}` : ""}
              </p>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-3">
          <input className={F} placeholder="Clinic name" value={f.clinic_name} onChange={set("clinic_name")} autoFocus />
          <div className="grid gap-3 sm:grid-cols-2">
            <input className={F} placeholder="Who to ask for" value={f.contact_name} onChange={set("contact_name")} />
            <input className={F} placeholder="Their role" value={f.contact_role} onChange={set("contact_role")} />
          </div>
          <input className={F} placeholder="Phone" value={f.phone} onChange={set("phone")} />
          <input className={F} placeholder="Address / area" value={f.address} onChange={set("address")} />
          <input className={F} placeholder="Google Maps link (optional)" value={f.map_url} onChange={set("map_url")} />
          <textarea className={F} rows={2} placeholder="Anything worth remembering" value={f.note} onChange={set("note")} />
          <select className={F} value={f.campaign_id} onChange={set("campaign_id")}>
            <option value="">No campaign yet</option>
            {(campaigns.data ?? []).filter((c) => c.is_active).map((c) => <option key={c.id} value={c.id}>Start in {c.name}</option>)}
          </select>
        </div>

        {err && <p className="mt-3 text-sm text-rose-400">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button className={GHOST} onClick={onClose}>Cancel</button>
          <button className={SOLID} disabled={!f.clinic_name || m.isPending} onClick={() => m.mutate()}>Add clinic</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- the campaign */

/** Designing the steps. Existing phases keep their identity when renamed or moved,
 *  so editing a campaign cannot empty the board. */
function CampaignDialog({ campaign, onClose }: { campaign: Campaign | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(campaign?.name ?? "");
  const [goal, setGoal] = useState(campaign?.goal ?? "");
  const [phases, setPhases] = useState<PhaseDraft[]>(
    campaign?.phases.map((p) => ({ id: p.id, name: p.name, intent: p.intent })) ??
    [{ name: "First visit" }, { name: "Follow up" }, { name: "Decision" }],
  );
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => campaign
      ? updateCampaign(campaign.id, { name, goal, phases })
      : createCampaign({ name, goal, phases }).then(() => undefined),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["crm-campaigns"] }); qc.invalidateQueries({ queryKey: ["crm-board"] }); onClose(); },
    onError: (e: Error) => setErr(e.message),
  });
  const upd = (i: number, k: keyof PhaseDraft, v: string) =>
    setPhases((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose}>
      <div className="mt-10 w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white">{campaign ? "Edit campaign" : "New campaign"}</h2>
        <div className="mt-4 space-y-3">
          <input className={F} placeholder="Campaign name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={F} placeholder="What is it for?" value={goal} onChange={(e) => setGoal(e.target.value)} />
          <div>
            <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">Phases, in order</p>
            <div className="space-y-2">
              {phases.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <span className="mt-2 w-5 shrink-0 text-sm text-zinc-600">{i + 1}.</span>
                  <div className="flex-1 space-y-1">
                    <input className={F} placeholder="Phase name" value={p.name} onChange={(e) => upd(i, "name", e.target.value)} />
                    <input className={F} placeholder="What the rep should do here" value={p.intent ?? ""} onChange={(e) => upd(i, "intent", e.target.value)} />
                  </div>
                  <button className="mt-1 h-8 shrink-0 rounded-md border border-zinc-700 px-2 text-xs text-zinc-400 hover:bg-zinc-800"
                    onClick={() => setPhases((ps) => ps.filter((_, j) => j !== i))}>Remove</button>
                </div>
              ))}
            </div>
            <button className={`${GHOST} mt-2`} onClick={() => setPhases((ps) => [...ps, { name: "" }])}>
              <Plus className="h-4 w-4" /> Add a phase
            </button>
          </div>
        </div>
        {err && <p className="mt-3 text-sm text-rose-400">{err}</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {campaign && (
            <button className={GHOST} onClick={() => setCampaignActive(campaign.id, !campaign.is_active)
              .then(() => { qc.invalidateQueries({ queryKey: ["crm-campaigns"] }); onClose(); })
              .catch((e: Error) => setErr(e.message))}>
              {campaign.is_active ? "Pause" : "Resume"}
            </button>
          )}
          <button className={GHOST} onClick={onClose}>Cancel</button>
          <button className={SOLID} disabled={!name || m.isPending} onClick={() => m.mutate()}>Save</button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- the team */

export function TeamView() {
  const qc = useQueryClient();
  const reps = useQuery({ queryKey: ["crm-reps"], queryFn: listReps });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ full_name: "", email: "", role: "marketer", password: "" });
  const [err, setErr] = useState("");
  const m = useMutation({
    mutationFn: () => createRep(f),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["crm-reps"] }); setAdding(false); setF({ full_name: "", email: "", role: "marketer", password: "" }); },
    onError: (e: Error) => setErr(e.message),
  });
  const rows = useMemo(() => reps.data ?? [], [reps.data]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm text-zinc-400"><Users className="h-4 w-4" /> {rows.length} accounts</p>
        <button className={SOLID} onClick={() => setAdding((a) => !a)}><Plus className="h-4 w-4" /> Add someone</button>
      </div>

      {adding && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <input className={F} placeholder="Full name" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
            <input className={F} placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <select className={F} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="marketer">Marketing — the pipeline only</option>
              <option value="admin">Admin — everything in this console</option>
            </select>
            <input className={F} type="password" placeholder="A password to give them" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            A marketing account can work the pipeline and nothing else — it cannot create, suspend or open a clinic workspace.
          </p>
          {err && <p className="mt-2 text-sm text-rose-400">{err}</p>}
          <button className={`${SOLID} mt-3`} disabled={m.isPending} onClick={() => m.mutate()}>Create the account</button>
        </div>
      )}

      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
            <div className="min-w-[12rem] flex-1">
              <p className="text-sm font-medium text-white">{r.full_name || r.email}</p>
              <p className="text-xs text-zinc-500">{r.email}</p>
            </div>
            <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300">
              {r.role === "marketer" ? "Marketing" : "Admin"}
            </span>
            <span className="text-xs text-zinc-400">{r.open} working · {r.signed_up} signed up</span>
            <button className={GHOST}
              onClick={() => setRepStatus(r.id, r.status === "active" ? "disabled" : "active")
                .then(() => qc.invalidateQueries({ queryKey: ["crm-reps"] }))}>
              {r.status === "active" ? "Disable" : "Enable"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export type { Prospect };
