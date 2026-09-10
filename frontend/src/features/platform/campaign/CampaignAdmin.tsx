import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  closePromo, deletePromoPrize, deletePromoQuestion, listPromos, openPromo, promoEntries,
  promoMissed, promoPrizes, promoQuestions, promoSignups, resetPromo, savePromo, savePromoPrize,
  savePromoQuestion, setPromoSignupStatus,
  type PromoCampaign, type PromoChoice, type PromoPrize, type PromoQuestion,
} from "@/features/platform/api";

const box = "rounded-lg border border-zinc-800 bg-zinc-900/40 p-4";
const num = (v: string) => Math.max(0, parseInt(v || "0", 10) || 0);

export function CampaignAdmin() {
  const q = useQuery({ queryKey: ["promos"], queryFn: listPromos });
  const [openId, setOpenId] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  const list = q.data ?? [];
  if (list.length === 0) return <p className="text-sm text-zinc-500">No campaigns yet.</p>;
  return (
    <div className="space-y-4">
      {list.map((c) => (
        <CampaignCard key={c.id} c={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} />
      ))}
    </div>
  );
}

function CampaignCard({ c, open, onToggle }: { c: PromoCampaign; open: boolean; onToggle: () => void }) {
  const qc = useQueryClient();
  const { ask, dialog } = useConfirmDialog();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["promos"] });
  const link = `${window.location.origin}/c/${c.code}`;

  const openMut = useMutation({
    mutationFn: () => openPromo(c.id),
    onSuccess: () => { toast.success("Sealed and open — the link works now"); invalidate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not open it"),
  });
  const resetMut = useMutation({
    mutationFn: () => resetPromo(c.id),
    onSuccess: () => { toast.success("Wiped — back to draft, ready to seal again"); invalidate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not reset it"),
  });
  const closeMut = useMutation({
    mutationFn: () => closePromo(c.id),
    onSuccess: () => { toast.success("Closed — the seed is published and any unclaimed gift has been drawn"); invalidate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not close it"),
  });

  return (
    <div className="rounded-xl border border-zinc-800">
      {dialog}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{c.title}</span>
            <Badge variant={c.status === "open" ? "success" : c.status === "closed" ? "outline" : "warning"}>{c.status}</Badge>
          </div>
          <div className="mt-1 space-y-0.5">
            {/* Two links, two jobs: the first goes to everyone, the second only to
                the clinics you invite after talking to them. */}
            <button className="flex items-center gap-1.5 font-mono text-xs text-emerald-300 hover:underline"
              onClick={() => { void navigator.clipboard?.writeText(`${link}/register`); toast.success("Sign-up link copied — send this one first, to everybody"); }}>
              <Copy className="h-3 w-3" /> {link}/register <span className="font-sans text-zinc-500">· sign-up</span>
            </button>
            <button className="flex items-center gap-1.5 font-mono text-xs text-sky-300 hover:underline"
              onClick={() => { void navigator.clipboard?.writeText(link); toast.success("Quiz link copied — send this only to clinics you have invited"); }}>
              <Copy className="h-3 w-3" /> {link} <span className="font-sans text-zinc-500">· quiz & wheel</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {c.status === "draft" && <Button size="sm" loading={openMut.isPending} onClick={() => openMut.mutate()}>Seal & open</Button>}
          {c.status === "open" && (
            <Button size="sm" variant="outline" loading={closeMut.isPending}
              onClick={() => ask({
                title: "Close the draw",
                description: `The secret number is published, and any of the ${c.gifts} gifts nobody reached is drawn among the clinics that played. This cannot be undone.`,
                confirmLabel: "Close and draw",
                destructive: true,
              }, () => closeMut.mutate())}>Close & draw</Button>
          )}
          {c.status !== "draft" && (
            <Button size="sm" variant="ghost" className="text-rose-400" loading={resetMut.isPending}
              onClick={() => ask({
                title: "Wipe this campaign and start again",
                description: `All ${c.entries} registered clinic${c.entries === 1 ? "" : "s"}, every answer and every spin are deleted, and a new secret is generated when you seal it again. Use this to clear a rehearsal — not after clinics have really played.`,
                confirmLabel: "Wipe it",
                destructive: true,
              }, () => resetMut.mutate())}>Reset</Button>
          )}
          <Button size="sm" variant="ghost" onClick={onToggle}>{open ? "Hide" : "Manage"}</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px border-t border-zinc-800 bg-zinc-800 text-center sm:grid-cols-5">
        <Stat label="Registered" value={c.entries} />
        <Stat label="Played" value={`${c.played} / ${c.chances}`} />
        <Stat label="Gifts left" value={`${c.gifts_left} / ${c.gifts}`} />
        <Stat label="Chances left" value={c.chances_left} />
        <Stat label="Waiting" value={c.waiting} warn={c.waiting > 0} />
      </div>
      {c.waiting > 0 && (
        <p className="border-t border-zinc-800 bg-amber-950/40 px-4 py-2 text-xs text-amber-300">
          {c.waiting} {c.waiting === 1 ? "clinic has" : "clinics have"} finished the questions and found the wheel full.
          Raise the number of chances to give them a turn.
        </p>
      )}

      {open && (
        <div className="space-y-5 border-t border-zinc-800 p-4">
          <Signups c={c} />
          <Settings c={c} onSaved={invalidate} />
          <Questions c={c} />
          <Prizes c={c} />
          <Entries c={c} />
        </div>
      )}
    </div>
  );
}

const Stat = ({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) => (
  <div className="bg-zinc-900 px-2 py-3">
    <div className={`text-lg font-semibold tabular-nums ${warn ? "text-amber-400" : ""}`}>{value}</div>
    <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
  </div>
);


const SIGNUP_STATES = ["new", "contacted", "invited", "joined", "declined"] as const;
const STATE_TONE: Record<string, string> = {
  new: "text-sky-300", contacted: "text-amber-300", invited: "text-violet-300",
  joined: "text-emerald-300", declined: "text-zinc-500",
};

/** The outreach list: clinics that put their hand up, before anybody plays. */
function Signups({ c }: { c: PromoCampaign }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["promo-signups", c.id], queryFn: () => promoSignups(c.id) });
  const [open, setOpen] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (v: { sid: string; status: string }) => setPromoSignupStatus(c.id, v.sid, v.status),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["promo-signups", c.id] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save it"),
  });
  const rows = q.data ?? [];
  const csv = () => {
    const head = "clinic,owner,phone,location,status,played,won,facilities,structure\n";
    const body = rows.map((r) => [r.clinic_name, r.owner_name, r.phone, r.location, r.status,
      r.played, r.won, r.facilities.join("; "), r.structure]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([head + body], { type: "text/csv" }));
    a.download = `${c.code}-signups.csv`;
    a.click();
  };
  const count = (s: string) => rows.filter((r) => r.status === s).length;

  return (
    <div className={box}>
      <div className="mb-3 flex items-center justify-between">
        <Label>
          Registered clinics <span className="text-xs font-normal text-zinc-500">— the list to reach out to</span>
        </Label>
        {rows.length > 0 && <Button size="sm" variant="outline" onClick={csv}>Download CSV</Button>}
      </div>
      {q.isLoading ? <Skeleton className="h-16 w-full" /> : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Nobody has registered yet. Send the sign-up link above.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-zinc-400">
            <span><b className="text-zinc-100">{rows.length}</b> registered</span>
            {SIGNUP_STATES.map((s) => count(s) > 0 && (
              <span key={s}><b className={STATE_TONE[s]}>{count(s)}</b> {s}</span>
            ))}
            <span><b className="text-emerald-300">{rows.filter((r) => r.played).length}</b> have played</span>
          </div>
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.id} className="rounded-md bg-zinc-900 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {r.clinic_name}
                      {r.played && <Badge variant="success" className="ml-2">played</Badge>}
                      {r.won && <Badge className="ml-1 bg-amber-500 text-zinc-950">won</Badge>}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {r.owner_name} · <a className="hover:underline" href={`tel:${r.phone}`}>{r.phone}</a> · {r.location}
                    </p>
                  </div>
                  <select
                    className="h-8 shrink-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs"
                    value={r.status}
                    onChange={(e) => mut.mutate({ sid: r.id, status: e.target.value })}>
                    {SIGNUP_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {r.facilities.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.facilities.map((f) => (
                      <span key={f} className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">{f}</span>
                    ))}
                  </div>
                )}
                {r.structure && (
                  <button className="mt-2 text-left text-xs text-zinc-400 hover:text-zinc-200"
                    onClick={() => setOpen(open === r.id ? null : r.id)}>
                    {open === r.id ? r.structure : `${r.structure.slice(0, 90)}${r.structure.length > 90 ? "…" : ""}`}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Settings({ c, onSaved }: { c: PromoCampaign; onSaved: () => void }) {
  const [f, setF] = useState({
    title: c.title, subtitle: c.subtitle, gift_label: c.gift_label, gift_detail: c.gift_detail,
    telegram: c.telegram, phone: c.phone,
    chances: String(c.chances), gifts: String(c.gifts),
    auto_extend: c.auto_extend ? "1" : "", extend_block: String(c.extend_block || 10),
    closes_at: c.closes_at ? c.closes_at.slice(0, 10) : "",
  });
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));
  const live = c.status !== "draft";
  const mut = useMutation({
    mutationFn: () => savePromo(c.id, {
      title: f.title, subtitle: f.subtitle, gift_label: f.gift_label, gift_detail: f.gift_detail,
      telegram: f.telegram, phone: f.phone, chances: num(f.chances), gifts: num(f.gifts),
      auto_extend: f.auto_extend === "1", extend_block: Math.max(1, num(f.extend_block)),
      closes_at: f.closes_at ? new Date(`${f.closes_at}T20:00:00+03:00`).toISOString() : undefined,
    }),
    onSuccess: () => { toast.success("Saved"); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save it"),
  });
  return (
    <div className={box}>
      <Label className="mb-3 block">Campaign</Label>
      <div className="grid gap-3 sm:grid-cols-2">
        <L t="Title (shown large, in Amharic)"><Input value={f.title} onChange={(e) => set("title", e.target.value)} /></L>
        <L t="Closes on"><Input type="date" value={f.closes_at} onChange={(e) => set("closes_at", e.target.value)} /></L>
        <L t="Subtitle" wide><Input value={f.subtitle} onChange={(e) => set("subtitle", e.target.value)} /></L>
        <L t="What the winners get" wide><Input value={f.gift_label} onChange={(e) => set("gift_label", e.target.value)} /></L>
        <L t="…and the detail under it" wide><Input value={f.gift_detail} onChange={(e) => set("gift_detail", e.target.value)} /></L>
        <L t="Telegram handle"><Input value={f.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="@clinicos" /></L>
        <L t="Phone"><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} placeholder="09…" /></L>
        <L t="Chances (how many clinics can play)">
          <Input type="number" min={1} value={f.chances} onChange={(e) => set("chances", e.target.value)} />
        </L>
        <L t="Gifts (how many win)">
          <Input type="number" min={0} value={f.gifts} onChange={(e) => set("gifts", e.target.value)} disabled={live} />
        </L>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={f.auto_extend === "1"}
          onChange={(e) => set("auto_extend", e.target.checked ? "1" : "")} />
        <span>
          Grow the wheel when it fills
          <span className="block text-xs text-zinc-500">
            You cannot know how many clinics will come. With this on, the {c.gifts_left === 0 ? c.gifts : c.gifts_left} gift
            {(c.gifts_left === 0 ? c.gifts : c.gifts_left) === 1 ? "" : "s"} still to be won are simply spread across more
            positions as more clinics arrive — nobody is turned away, and three is still three. With it off, clinic
            number {c.chances + 1} is told to wait.
          </span>
        </span>
      </label>
      {f.auto_extend === "1" && (
        <div className="mt-2 flex items-center gap-2">
          <Label className="text-xs text-zinc-400">Add this many at a time</Label>
          <Input type="number" min={1} className="w-24" value={f.extend_block}
            onChange={(e) => set("extend_block", e.target.value)} />
        </div>
      )}
      <p className="mt-3 rounded-md bg-zinc-950 px-3 py-2 text-xs text-zinc-300">
        <b>How the spin works right now:</b> {num(f.gifts)} gift{num(f.gifts) === 1 ? "" : "s"} spread across{" "}
        {num(f.chances)} position{num(f.chances) === 1 ? "" : "s"} — each clinic has a{" "}
        <b className="text-amber-300">
          {num(f.chances) > 0 ? `${num(f.gifts)} in ${num(f.chances)} (${Math.round((num(f.gifts) / num(f.chances)) * 100)}%)`
            : "—"}
        </b>{" "}
        chance of the gift, and every other position is one of the offers below, so nobody spins a
        losing wheel. Positions are decided by a secret number before anyone plays and handed out in
        the order clinics finish, so arriving late does not change the odds.
      </p>
      {live && (
        <p className="mt-2 text-xs text-zinc-500">
          The campaign is sealed. You can add chances — new positions are appended and the unclaimed
          ones re-sealed, keeping the {c.gifts_left} gift{c.gifts_left === 1 ? "" : "s"} still to be won —
          but you cannot take chances away or change how many gifts there are.
        </p>
      )}
      <Button size="sm" className="mt-3" loading={mut.isPending} onClick={() => mut.mutate()}>Save</Button>
    </div>
  );
}

const L = ({ t, wide, children }: { t: string; wide?: boolean; children: React.ReactNode }) => (
  <div className={`space-y-1 ${wide ? "sm:col-span-2" : ""}`}>
    <Label className="text-xs text-zinc-400">{t}</Label>
    {children}
  </div>
);

const EMPTY_Q: Omit<PromoQuestion, "id"> = {
  prompt: "", teaches: "", sort: 0, active: true,
  choices: [{ label: "", correct: true, explain: "" }, { label: "", correct: false, explain: "" }],
};

function Questions({ c }: { c: PromoCampaign }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["promo-questions", c.id], queryFn: () => promoQuestions(c.id) });
  const [editing, setEditing] = useState<{ id: string | null; draft: Omit<PromoQuestion, "id"> } | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["promo-questions", c.id] });
  const del = useMutation({
    mutationFn: (qid: string) => deletePromoQuestion(c.id, qid),
    onSuccess: () => { toast.success("Question removed"); invalidate(); },
  });

  return (
    <div className={box}>
      <div className="mb-3 flex items-center justify-between">
        <Label>Questions <span className="text-xs font-normal text-zinc-500">— what every clinic will learn</span></Label>
        <Button size="sm" variant="outline" onClick={() => setEditing({ id: null, draft: { ...EMPTY_Q, sort: ((q.data?.length ?? 0) + 1) * 10 } })}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {q.isLoading ? <Skeleton className="h-20 w-full" /> : (
        <div className="space-y-2">
          {(q.data ?? []).map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-3 rounded-md bg-zinc-900 p-3">
              <div className="min-w-0">
                <p className="text-sm">{item.prompt}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {item.choices.length} answers · correct: {item.choices.find((x) => x.correct)?.label ?? "—"}
                  {!item.active && " · hidden"}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button className="text-xs text-sky-300 hover:underline" onClick={() => setEditing({ id: item.id, draft: item })}>Edit</button>
                <button className="text-xs text-rose-400 hover:underline" onClick={() => del.mutate(item.id)}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <QuestionEditor campaignId={c.id} id={editing.id} draft={editing.draft}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); invalidate(); }} />
      )}
    </div>
  );
}

function QuestionEditor({ campaignId, id, draft, onClose, onSaved }:
  { campaignId: string; id: string | null; draft: Omit<PromoQuestion, "id">; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState(draft);
  const setChoice = (i: number, patch: Partial<PromoChoice>) =>
    setD((s) => ({ ...s, choices: s.choices.map((c, n) => (n === i ? { ...c, ...patch } : c)) }));
  const markCorrect = (i: number) =>
    setD((s) => ({ ...s, choices: s.choices.map((c, n) => ({ ...c, correct: n === i })) }));
  const mut = useMutation({
    mutationFn: () => savePromoQuestion(campaignId, id, d),
    onSuccess: () => { toast.success("Saved"); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save the question"),
  });
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-sky-900/60 bg-zinc-950 p-4">
      <L t="The question" wide><Input value={d.prompt} onChange={(e) => setD({ ...d, prompt: e.target.value })} /></L>
      <L t="What we say when they get it right" wide>
        <Input value={d.teaches} onChange={(e) => setD({ ...d, teaches: e.target.value })} />
      </L>
      <div className="space-y-2">
        <Label className="text-xs text-zinc-400">Answers — tick the right one; every wrong one needs an explanation</Label>
        <p className="text-xs text-zinc-500">
          The order does not matter: every clinic sees these shuffled into its own order, so the
          right answer is never in the same place twice.
        </p>
        {d.choices.map((ch, i) => (
          <div key={i} className="space-y-1 rounded-md bg-zinc-900 p-2">
            <div className="flex items-center gap-2">
              <input type="radio" checked={ch.correct} onChange={() => markCorrect(i)} aria-label="correct answer" />
              <Input value={ch.label} onChange={(e) => setChoice(i, { label: e.target.value })} placeholder="Answer" />
              {d.choices.length > 2 && (
                <button className="text-rose-400" onClick={() => setD({ ...d, choices: d.choices.filter((_, n) => n !== i) })}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {!ch.correct && (
              <Input value={ch.explain} onChange={(e) => setChoice(i, { explain: e.target.value })}
                placeholder="Why this is wrong, and what the software actually does" />
            )}
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setD({ ...d, choices: [...d.choices, { label: "", correct: false, explain: "" }] })}>
          <Plus className="h-3.5 w-3.5" /> Another answer
        </Button>
      </div>
      <div className="flex gap-2">
        <Button size="sm" loading={mut.isPending} onClick={() => mut.mutate()}>Save question</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}

function Prizes({ c }: { c: PromoCampaign }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["promo-prizes", c.id], queryFn: () => promoPrizes(c.id) });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["promo-prizes", c.id] });
  const [draft, setDraft] = useState<{ id: string | null; p: Omit<PromoPrize, "id"> } | null>(null);
  const del = useMutation({ mutationFn: (pid: string) => deletePromoPrize(c.id, pid), onSuccess: () => { toast.success("Removed"); invalidate(); } });
  const save = useMutation({
    mutationFn: () => savePromoPrize(c.id, draft!.id, draft!.p),
    onSuccess: () => { toast.success("Saved"); setDraft(null); invalidate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save it"),
  });
  return (
    <div className={box}>
      <div className="mb-3 flex items-center justify-between">
        <Label>The other segments <span className="text-xs font-normal text-zinc-500">— what a clinic wins when it does not win the gift</span></Label>
        <Button size="sm" variant="outline" onClick={() => setDraft({ id: null, p: { label: "", detail: "", weight: 1, sort: 99 } })}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {q.isLoading ? <Skeleton className="h-16 w-full" /> : (
        <div className="space-y-2">
          {(q.data ?? []).map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-md bg-zinc-900 p-3">
              <div className="min-w-0">
                <p className="text-sm">{p.label}</p>
                {p.detail && <p className="text-xs text-zinc-500">{p.detail}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-zinc-500">×{p.weight}</span>
                <button className="text-xs text-sky-300 hover:underline" onClick={() => setDraft({ id: p.id, p })}>Edit</button>
                <button className="text-rose-400" onClick={() => del.mutate(p.id)}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      {draft && (
        <div className="mt-3 space-y-2 rounded-lg border border-sky-900/60 bg-zinc-950 p-3">
          <Input value={draft.p.label} placeholder="e.g. 20% off the implementation"
            onChange={(e) => setDraft({ ...draft, p: { ...draft.p, label: e.target.value } })} />
          <Input value={draft.p.detail} placeholder="One line of detail"
            onChange={(e) => setDraft({ ...draft, p: { ...draft.p, detail: e.target.value } })} />
          <div className="flex items-center gap-2">
            <Label className="text-xs text-zinc-400">How many positions</Label>
            <Input type="number" min={1} className="w-24" value={String(draft.p.weight)}
              onChange={(e) => setDraft({ ...draft, p: { ...draft.p, weight: Math.max(1, num(e.target.value)) } })} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Entries({ c }: { c: PromoCampaign }) {
  const q = useQuery({ queryKey: ["promo-entries", c.id], queryFn: () => promoEntries(c.id) });
  const m = useQuery({ queryKey: ["promo-missed", c.id], queryFn: () => promoMissed(c.id) });
  const rows = q.data ?? [];
  const csv = () => {
    const head = "name,phone,clinic,finished,played,won,prize\n";
    const body = rows.map((r) => [r.full_name, r.phone, r.clinic_name, r.quiz_done, r.spun, r.won, r.prize_label ?? ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([head + body], { type: "text/csv" }));
    a.download = `${c.code}-clinics.csv`;
    a.click();
  };
  return (
    <div className={box}>
      <div className="mb-3 flex items-center justify-between">
        <Label>Clinics <span className="text-xs font-normal text-zinc-500">— the list this campaign is really for</span></Label>
        {rows.length > 0 && <Button size="sm" variant="outline" onClick={csv}>Download CSV</Button>}
      </div>
      {q.isLoading ? <Skeleton className="h-16 w-full" /> : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">Nobody has registered yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr><th className="py-1">Clinic</th><th>Who</th><th>Phone</th><th>State</th><th>Won</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800">
                  <td className="py-1.5">{r.clinic_name}</td>
                  <td>{r.full_name}</td>
                  <td className="whitespace-nowrap"><a className="hover:underline" href={`tel:${r.phone}`}>{r.phone}</a></td>
                  <td className="text-xs text-zinc-400">{r.spun ? "played" : r.quiz_done ? "waiting to spin" : "in the questions"}</td>
                  <td className="text-xs">{r.won ? <Badge variant="success">gift</Badge> : r.prize_label || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(m.data ?? []).some((x) => x.wrong > 0) && (
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <Label className="text-xs text-zinc-400">Least known — what clinics get wrong most</Label>
          <ul className="mt-2 space-y-1 text-xs text-zinc-400">
            {(m.data ?? []).filter((x) => x.wrong > 0).slice(0, 5).map((x) => (
              <li key={x.prompt}>
                <span className="text-amber-400">{x.wrong}</span> wrong of {x.asked} — {x.prompt}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
