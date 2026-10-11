// What a pharmacist (or an employer) sees after scanning the QR on a paper.
//
// Designed for a phone held in one hand across a counter, in a hurry, by someone who
// has never seen this page before and has no account. So: the answer comes first, in
// words and in colour and in an icon (colour alone fails for a colour-blind reader),
// and what to DO is said in the same breath. The record's details come second, large
// enough to compare with the paper at arm's length.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AlertTriangle, CalendarDays, Check, CircleHelp, Clock, Copy, Eye, Hospital, PackageCheck, Pill, RefreshCw,
  ShieldAlert, ShieldCheck, ShieldX, Stethoscope, UserRound, WifiOff,
} from "lucide-react";

import { AppError } from "@/lib/api-client";
import { formatEthiopian } from "@/lib/ethiopian";
import { checkPaper, logoUrl, type CheckResult } from "@/features/verify/api";

type View =
  | { kind: "loading" }
  | { kind: "result"; r: CheckResult }
  | { kind: "missing" }
  | { kind: "slow" }
  | { kind: "offline" };

const ADDIS = "Africa/Addis_Ababa";
const dayOf = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00+03:00`);

/** "11 Oct 2026" for a calendar day. */
const longDay = (iso: string) =>
  dayOf(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: ADDIS });
const timeOf = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ADDIS });

function ago(n: number) {
  if (n <= 0) return "today";
  return n === 1 ? "yesterday" : `${n} days ago`;
}

export function VerifyPage() {
  const { slug = "", key = "" } = useParams();
  const [view, setView] = useState<View>({ kind: "loading" });
  // One look is one count: do not ask twice for the same paper from a re-render.
  const asked = useRef("");

  const run = useCallback(() => {
    setView({ kind: "loading" });
    checkPaper(slug, key)
      .then((r) => setView({ kind: "result", r }))
      .catch((e) => {
        if (e instanceof AppError && e.status === 404) setView({ kind: "missing" });
        else if (e instanceof AppError && e.status === 429) setView({ kind: "slow" });
        else setView({ kind: "offline" });
      });
  }, [slug, key]);

  useEffect(() => {
    const id = `${slug}/${key}`;
    if (asked.current === id) return;
    asked.current = id;
    run();
  }, [slug, key, run]);

  return (
    <div className="min-h-dvh bg-slate-100 text-slate-900">
      <main className="mx-auto w-full max-w-md px-4 pb-12 pt-5" aria-live="polite">
        {view.kind === "loading" && <Loading />}
        {view.kind === "result" && <Result r={view.r} />}
        {view.kind === "missing" && <NotFound />}
        {view.kind === "slow" && <Problem icon={<Clock className="h-7 w-7" />} title="Too many tries"
          body="Please wait a minute, then try again." onRetry={run} />}
        {view.kind === "offline" && <Problem icon={<WifiOff className="h-7 w-7" />} title="Could not reach the check"
          body="Check your connection and try again. The paper may still be genuine; this page just could not be reached." onRetry={run} />}
        <Footer />
      </main>
    </div>
  );
}

// ---- the answer ----------------------------------------------------------------------

const TONE = {
  ok: { panel: "bg-emerald-700 text-white", chip: "bg-white/15" },
  warn: { panel: "bg-amber-500 text-amber-950", chip: "bg-black/10" },
  bad: { panel: "bg-rose-700 text-white", chip: "bg-white/15" },
  plain: { panel: "bg-slate-700 text-white", chip: "bg-white/15" },
} as const;

function Status({ tone, icon, title, body }: { tone: keyof typeof TONE; icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <section role="status" className={`mt-4 rounded-2xl p-5 shadow-sm ${TONE[tone].panel}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${TONE[tone].chip}`}>{icon}</span>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight text-inherit">{title}</h1>
          <p className="mt-1 text-base leading-snug opacity-95">{body}</p>
        </div>
      </div>
    </section>
  );
}

function Result({ r }: { r: CheckResult }) {
  const live = r.status === "genuine" || r.status === "expired";
  const dispensed = live && !!r.dispensed_at;
  const eth = formatEthiopian(dayOf(r.written_at), { dayFirst: true });

  return (
    <>
      <Identity r={r} />
      {r.status === "genuine" && !dispensed && (
        <Status tone="ok" icon={<ShieldCheck className="h-6 w-6" />} title="Genuine prescription"
          body={<>Issued by {r.clinic} {ago(r.days_ago)}. Compare the medicines below with the paper in your hand.</>} />
      )}
      {r.status === "genuine" && dispensed && (
        <Status tone="warn" icon={<PackageCheck className="h-6 w-6" />} title="Already dispensed"
          body={<>The clinic's pharmacy handed this over on {longDay(r.dispensed_at!)}. Do not dispense it again.</>} />
      )}
      {r.status === "expired" && (
        <Status tone="warn" icon={<Clock className="h-6 w-6" />} title="Past its validity"
          body={<>It was valid until {r.valid_until ? longDay(r.valid_until) : "an earlier date"}. Ask the patient to return to the clinic for a new one.</>} />
      )}
      {r.status === "cancelled" && (
        <Status tone="bad" icon={<ShieldX className="h-6 w-6" />} title="Cancelled by the clinic"
          body={<><b>Do not dispense.</b> Ask the patient to return to {r.clinic}.</>} />
      )}
      {r.status === "superseded" && (
        <Status tone="bad" icon={<ShieldAlert className="h-6 w-6" />} title="A newer version exists"
          body={<><b>Do not dispense from this paper.</b> It was changed after it was printed. Ask {r.clinic} for the current prescription.</>} />
      )}

      {live && <Details r={r} eth={eth} />}
      {!live && <Gone r={r} eth={eth} />}
      <Looks r={r} />
      <HowTo />
    </>
  );
}

function Identity({ r }: { r: CheckResult }) {
  const [broken, setBroken] = useState(false);
  const initials = r.clinic.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "C";
  return (
    <header className="flex items-center gap-3">
      {r.has_logo && !broken ? (
        <img src={logoUrl(r.slug)} alt="" onError={() => setBroken(true)}
          className="h-12 w-12 shrink-0 rounded-full border border-slate-200 bg-white object-cover" />
      ) : (
        <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-800 text-lg font-bold text-white">{initials}</span>
      )}
      <div className="min-w-0">
        <p className="truncate text-lg font-semibold leading-tight">{r.clinic}</p>
        {r.branch && <p className="truncate text-sm text-slate-600">{r.branch}</p>}
      </div>
    </header>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 text-slate-500" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
        <dd className="mt-0.5 text-base">{children}</dd>
      </div>
    </div>
  );
}

function Details({ r, eth }: { r: CheckResult; eth: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(r.ref).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };
  return (
    <>
      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" aria-labelledby="meds">
        <h2 id="meds" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
          <Pill className="h-4 w-4" aria-hidden /> Medicines
        </h2>
        <ol aria-label="Medicines" className="mt-3 space-y-3">
          {(r.medicines ?? []).map((m, i) => (
            <li key={i} className="rounded-xl bg-slate-50 p-3">
              <p className="text-lg font-semibold leading-snug">{m.name}</p>
              <p className="mt-1 flex flex-wrap gap-1.5">
                {[m.dose, m.frequency, m.duration].filter(Boolean).map((t) => (
                  <span key={t} className="rounded-full bg-white px-2.5 py-0.5 text-sm ring-1 ring-slate-200">{t}</span>
                ))}
              </p>
              {m.instructions && <p className="mt-1.5 text-sm italic text-slate-600">{m.instructions}</p>}
            </li>
          ))}
        </ol>
        {r.note && <p className="mt-3 border-t pt-3 text-sm text-slate-700"><span className="font-medium">Note: </span>{r.note}</p>}
      </section>

      <dl className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-4 shadow-sm">
        {r.patient && (
          <Row icon={<UserRound className="h-5 w-5" />} label="Patient">
            {r.patient.name} · {r.patient.age} years{r.patient.gender && r.patient.gender !== "unknown" ? ` · ${r.patient.gender}` : ""}
          </Row>
        )}
        {r.prescriber && <Row icon={<Stethoscope className="h-5 w-5" />} label="Prescriber">{r.prescriber}</Row>}
        <Row icon={<CalendarDays className="h-5 w-5" />} label="Written">
          {longDay(r.written_at)} <span className="text-slate-500">· {eth}</span>
          {r.valid_until && <span className="block text-sm text-slate-600">Valid until {longDay(r.valid_until)}</span>}
        </Row>
        <Row icon={<Hospital className="h-5 w-5" />} label="Reference">
          <button type="button" onClick={copy} aria-label={`Copy reference ${r.ref}`}
            className="inline-flex items-center gap-2 font-mono text-base font-semibold">
            {r.ref}
            {copied ? <Check className="h-4 w-4 text-emerald-600" aria-hidden /> : <Copy className="h-4 w-4 text-slate-400" aria-hidden />}
          </button>
        </Row>
      </dl>
    </>
  );
}

/** A paper that is withdrawn or replaced shows only whose it was and which one. */
function Gone({ r, eth }: { r: CheckResult; eth: string }) {
  return (
    <dl className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white px-4 shadow-sm">
      <Row icon={<Hospital className="h-5 w-5" />} label="Reference"><span className="font-mono font-semibold">{r.ref}</span></Row>
      <Row icon={<CalendarDays className="h-5 w-5" />} label="Written">
        {longDay(r.written_at)} <span className="text-slate-500">· {eth}</span>
      </Row>
    </dl>
  );
}

/** How often the paper has been checked: told plainly, never as an accusation. */
function Looks({ r }: { r: CheckResult }) {
  const n = r.checks.before;
  if (n === 0) {
    return (
      <p className="mt-4 flex items-start gap-2 rounded-xl px-1 text-sm text-slate-600">
        <Eye className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> This is the first time this paper has been checked.
      </p>
    );
  }
  return (
    <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <p>
        <b>Checked {n === 1 ? "once" : `${n} times`} before</b>
        {r.checks.first_at ? <>, first on {timeOf(r.checks.first_at)}</> : null}. A paper can be checked by the patient, the clinic
        or a pharmacy. If this one has been shown elsewhere, ask the patient.
      </p>
    </div>
  );
}

function HowTo() {
  return (
    <details className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <summary className="cursor-pointer text-base font-semibold">How to check a paper</summary>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-slate-700">
        <li>Read the medicines, doses and number of days above.</li>
        <li>Compare them with the paper in your hand, word for word.</li>
        <li>Check the reference matches the one printed on the paper.</li>
        <li>If anything differs, or this page says cancelled, do not dispense. Ask the patient to return to the clinic.</li>
      </ol>
      <p className="mt-3 text-slate-600">
        This page shows the clinic's record as it is now. The address should begin with <b>{window.location.host}</b>.
      </p>
    </details>
  );
}

// ---- the other answers ---------------------------------------------------------------

function NotFound() {
  return (
    <>
      <div className="h-12" aria-hidden />
      <Status tone="plain" icon={<CircleHelp className="h-6 w-6" />} title="We could not find this paper"
        body="The link may be mistyped, or the paper may not come from a clinic that uses this system. Do not rely on it until the clinic confirms it." />
      <p className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
        Typing the code from the paper by hand? <Link to="/v" className="font-semibold underline">Enter it here</Link>.
      </p>
    </>
  );
}

function Problem({ icon, title, body, onRetry }: { icon: ReactNode; title: string; body: string; onRetry: () => void }) {
  return (
    <>
      <div className="h-12" aria-hidden />
      <Status tone="plain" icon={icon} title={title} body={body} />
      <button type="button" onClick={onRetry}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-base font-semibold text-white">
        <RefreshCw className="h-4 w-4" aria-hidden /> Try again
      </button>
    </>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="animate-pulse pt-2">
      <div className="flex items-center gap-3">
        <div className="h-12 w-12 rounded-full bg-slate-300" />
        <div className="space-y-2"><div className="h-4 w-40 rounded bg-slate-300" /><div className="h-3 w-24 rounded bg-slate-200" /></div>
      </div>
      <div className="mt-4 h-28 rounded-2xl bg-slate-300" />
      <div className="mt-4 h-40 rounded-2xl bg-slate-200" />
      <span className="sr-only">Checking the paper…</span>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-8 text-center text-xs text-slate-500">
      Checked {new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ADDIS })}
      {" · "}ClinicOS
    </footer>
  );
}
