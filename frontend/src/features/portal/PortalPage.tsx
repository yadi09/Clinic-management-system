// The patient's own page, at /p/<clinic>. No staff account: the patient types the card
// number printed on their patient card and sees their treatment, payments and teeth.
//
// Built for a phone held in one hand. Sections sit side by side and slide (swipe, or
// tap a tab); English and Amharic are one switch, never both at once. Everything here
// is read-only — the server only ever returns this one patient's record.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";

import { AppError } from "@/lib/api-client";
import { lazyWithReload } from "@/app/chunkRecovery";
import { AnatomicalChart } from "@/features/dental/anatomical/AnatomicalChart";
import { toothName } from "@/features/dental/anatomical/geometry";
import { fromItems, items, SL } from "@/features/dental/anatomical/model";
import { portalLogin, portalLogo, portalMe, type PortalMe, type PortalTreatment } from "@/features/portal/api";
import { T, type Lang } from "@/features/portal/text";

const Dental3D = lazyWithReload(() => import("@/features/dental/anatomical/three/Dental3D"));

// The chart paints with the app's tokens; pin them to the light values so a patient's
// phone in dark mode still reads like the clinic's page.
const LIGHT = {
  "--text-accent": "#1F4E79", "--text-danger": "#E24B4A", "--text-success": "#3B6D11", "--text-warning": "#B5651D",
  "--text-secondary": "#617085", "--text-muted": "#8a9bab", "--surface-1": "#F2F7FB", "--surface-2": "#E6EEF5",
  "--border": "#dbe5ee", "--border-strong": "#b9c6d4", "--bg-accent": "#E6F1FB", colorScheme: "light",
} as React.CSSProperties;

const KEY = (slug: string) => `portal-token:${slug}`;
const money = (s?: string) => (s == null ? "" : Number(s).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const ADDIS = "Africa/Addis_Ababa";
const day = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(`${iso.slice(0, 10)}T12:00:00+03:00`).toLocaleDateString("en-GB", { ...o, timeZone: ADDIS });
const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* private window */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* private window */ } },
};
const savedLang = (): Lang => { try { return localStorage.getItem("portal-lang") === "am" ? "am" : "en"; } catch { return "en"; } };

export function PortalPage() {
  const { slug = "" } = useParams();
  const [lang, setLangState] = useState<Lang>(savedLang);
  const setLang = (l: Lang) => { setLangState(l); try { localStorage.setItem("portal-lang", l); } catch { /* ignore */ } };
  const [token, setToken] = useState<string | null>(() => store.get(KEY(slug)));
  const [me, setMe] = useState<PortalMe | null>(null);
  const [gone, setGone] = useState(false);
  const t = T[lang];

  const load = useCallback((tok: string) => {
    portalMe(slug, tok).then(setMe).catch((e) => {
      if (e instanceof AppError && e.status === 401) { store.del(KEY(slug)); setToken(null); setMe(null); } else setGone(true);
    });
  }, [slug]);
  useEffect(() => { if (token) load(token); }, [token, load]);

  const signOut = () => { store.del(KEY(slug)); setToken(null); setMe(null); };
  const signedIn = (tok: string) => { store.set(KEY(slug), tok); setToken(tok); };

  return (
    <div lang={lang} style={LIGHT} className="min-h-dvh bg-[#e8eef4] text-[#1f2a37]">
      <meta name="robots" content="noindex" />
      <div className="mx-auto flex h-dvh max-w-[430px] flex-col overflow-hidden bg-[#F2F7FB] sm:my-4 sm:h-[calc(100dvh-2rem)] sm:rounded-[28px] sm:shadow-2xl">
        {!token || (!me && !gone) ? (
          <Login slug={slug} lang={lang} setLang={setLang} onDone={signedIn} loading={!!token} />
        ) : gone || !me ? (
          <div className="p-8 text-center text-sm" role="alert">{t.offline}
            <button type="button" className="mt-4 block w-full rounded-xl bg-[#148F77] p-3 font-bold text-white" onClick={() => { setGone(false); load(token); }}>{t.retry}</button></div>
        ) : (
          <App me={me} lang={lang} setLang={setLang} onSignOut={signOut} />
        )}
      </div>
    </div>
  );
}

function LangSwitch({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <div role="group" aria-label="Language" className="inline-flex overflow-hidden rounded-lg border border-white/45 text-xs">
      {(["en", "am"] as const).map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}
          className={`px-2.5 py-1.5 ${lang === l ? "bg-white font-bold text-[#1F4E79]" : "text-white"}`}>{l === "en" ? "EN" : "አማ"}</button>
      ))}
    </div>
  );
}

function Logo({ slug, name, has, size = 38 }: { slug: string; name: string; has: boolean; size?: number }) {
  const [broken, setBroken] = useState(false);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white font-extrabold text-[#1F4E79]">
      {has && !broken ? <img src={portalLogo(slug)} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} /> : <span style={{ fontSize: size * 0.4 }}>{initials}</span>}
    </span>
  );
}

/* ---------------------------------- sign in ---------------------------------- */

function Login({ slug, lang, setLang, onDone, loading }: { slug: string; lang: Lang; setLang: (l: Lang) => void; onDone: (tok: string) => void; loading: boolean }) {
  const t = T[lang];
  const [card, setCard] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (card.trim().length < 3) { setErr(t.typeCard); return; }
    setBusy(true); setErr("");
    try { onDone((await portalLogin(slug, card.trim())).token); }
    catch (e) { setErr(e instanceof AppError && e.status === 429 ? t.slow : e instanceof AppError && e.status === 401 ? t.noCard : t.offline); setBusy(false); }
  };
  return (
    <div className="flex flex-1 flex-col gap-3.5 px-6 pb-6 pt-4" style={{ background: "linear-gradient(180deg,#1F4E79 0,#1F4E79 250px,#F2F7FB 250px)" }}>
      <div className="flex justify-end"><LangSwitch lang={lang} setLang={setLang} /></div>
      <div className="mb-1.5 mt-6 text-center text-white">
        <div className="mx-auto mb-2.5 w-fit"><Logo slug={slug} name={slug} has size={62} /></div>
        <h1 className="m-0 text-xl font-bold capitalize">{slug.replace(/-/g, " ")}</h1>
        <p className="mt-1 text-[13px] opacity-85">{t.welcome}</p>
      </div>
      <form className="rounded-[18px] bg-white p-5 shadow-lg" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label htmlFor="card" className="mb-1.5 block text-xs text-[#617085]">{t.cardno}</label>
        <input id="card" value={card} onChange={(e) => setCard(e.target.value)} autoComplete="off" autoCapitalize="characters" inputMode="text"
          placeholder="MRN-000123" className="w-full rounded-xl border-[1.5px] border-[#dbe5ee] p-3 text-lg tracking-wide outline-none focus:border-[#148F77]" />
        <p role="alert" className="mt-2 min-h-4 text-xs text-[#b4322f]">{err}</p>
        <button type="submit" disabled={busy || loading} className="mt-3 w-full rounded-xl bg-[#148F77] p-3.5 text-[15px] font-bold text-white disabled:opacity-60">{busy || loading ? t.wait : t.see}</button>
      </form>
      <p className="text-center text-xs text-[#617085]">{t.findcard}</p>
    </div>
  );
}

/* ------------------------------------ the app ------------------------------------ */

type Tab = "home" | "treat" | "pay" | "teeth";

function App({ me, lang, setLang, onSignOut }: { me: PortalMe; lang: Lang; setLang: (l: Lang) => void; onSignOut: () => void }) {
  const t = T[lang];
  const s = me.settings;
  const tabs = useMemo(() => [
    { k: "home" as Tab, label: t.home }, { k: "treat" as Tab, label: t.treat },
    ...(s.show_money ? [{ k: "pay" as Tab, label: t.pay }] : []),
    ...(s.show_teeth && me.chart ? [{ k: "teeth" as Tab, label: t.teeth }] : []),
  ], [t, s.show_money, s.show_teeth, me.chart]);
  const pager = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);
  const go = (i: number) => { const el = pager.current; if (el) el.scrollTo?.({ left: el.clientWidth * i, behavior: "smooth" }); setIdx(i); };
  const onScroll = () => { const el = pager.current; if (el && el.clientWidth) setIdx(Math.round(el.scrollLeft / el.clientWidth)); };

  return (
    <>
      <header className="flex items-center gap-2.5 bg-[#1F4E79] px-4 pb-3 pt-3.5 text-white">
        <Logo slug={me.clinic.slug} name={me.clinic.name} has={me.clinic.has_logo} />
        <div className="min-w-0"><div className="truncate text-[15px] font-bold leading-tight">{me.clinic.name}</div><div className="text-[11px] opacity-75">{t.portal}</div></div>
        <div className="ml-auto flex items-center gap-2"><LangSwitch lang={lang} setLang={setLang} />
          <button type="button" onClick={onSignOut} className="text-[11px] underline opacity-80">{t.out}</button></div>
      </header>
      <div role="tablist" className="flex border-b border-[#dbe5ee] bg-white">
        {tabs.map((x, i) => (
          <button key={x.k} role="tab" type="button" aria-selected={idx === i} onClick={() => go(i)}
            className={`flex-1 border-b-[3px] px-0.5 pb-2 pt-2.5 text-[13px] ${idx === i ? "border-[#148F77] font-bold text-[#1F4E79]" : "border-transparent text-[#617085]"}`}>{x.label}</button>
        ))}
      </div>
      <div ref={pager} onScroll={onScroll} className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto [scrollbar-width:none]">
        {tabs.map((x) => (
          <section key={x.k} role="tabpanel" aria-label={x.label} className="w-full shrink-0 snap-start overflow-y-auto px-3.5 pb-7 pt-3.5">
            {x.k === "home" && <Home me={me} t={t} />}
            {x.k === "treat" && <Treatment me={me} t={t} />}
            {x.k === "pay" && <Payments me={me} t={t} />}
            {x.k === "teeth" && <Teeth me={me} t={t} />}
          </section>
        ))}
      </div>
      <div className="border-t border-[#dbe5ee] bg-white p-1.5 text-center text-[11px] text-[#617085]">{t.swipe}</div>
    </>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return <div className="mb-3 rounded-2xl bg-white p-3.5 shadow-sm">{title && <h3 className="mb-2 text-[12.5px] font-semibold text-[#617085]">{title}</h3>}{children}</div>;
}

function Bar({ pct }: { pct: number }) {
  return <div className="my-2 h-2 overflow-hidden rounded-full bg-[#e6eef5]"><i className="block h-full rounded-full bg-[#148F77]" style={{ width: `${Math.min(100, pct)}%` }} /></div>;
}

const current = (me: PortalMe) => me.treatments.find((x) => x.status === "active") ?? me.treatments[0];
const pct = (x: PortalTreatment) => (x.of ? (x.done / x.of) * 100 : 0);

function Home({ me, t }: { me: PortalMe; t: (typeof T)[Lang] }) {
  const cur = current(me), m = me.money;
  return (
    <>
      <h2 className="mx-0.5 mb-0.5 mt-1 text-[21px] font-extrabold">{t.hello} {me.first_name}</h2>
      <p className="mx-0.5 mb-3 text-[13px] text-[#617085]">{t.homesub}</p>
      {me.next && (
        <Card title={t.next}>
          <div className="flex items-center gap-3">
            <div className="min-w-[62px] rounded-xl bg-[#F2F7FB] px-3 py-2 text-center">
              <b className="block text-[22px] leading-none text-[#1F4E79]">{day(me.next.date, { day: "numeric" })}</b>
              <span className="text-[11px] text-[#617085]">{day(me.next.date, { month: "short" })}</span></div>
            <div><b className="text-[15px]">{me.next.title}</b><div className="text-[13px] text-[#617085]">{t.visit} {me.next.seq}{me.next.of ? ` / ${me.next.of}` : ""} · {day(me.next.date, { weekday: "long" })}</div></div>
          </div>
          {me.clinic.phone && <a href={`tel:${me.clinic.phone.replace(/\s/g, "")}`} className="mt-3 block rounded-xl bg-[#148F77] p-3 text-center text-sm font-bold text-white">{t.call}</a>}
        </Card>
      )}
      {cur && (
        <Card title={t.yourTreat}>
          <div className="flex justify-between text-sm"><b>{cur.title}{cur.tooth ? ` · ${cur.tooth}` : ""}</b>
            <span className="rounded-full bg-[#E6F1FB] px-2.5 py-0.5 text-[11px] font-bold text-[#185FA5]">{cur.status === "completed" ? t.finished : t.inprog}</span></div>
          <Bar pct={pct(cur)} /><div className="text-xs text-[#617085]">{cur.done} / {cur.of} {t.visitsDone}</div>
        </Card>
      )}
      {!cur && <Card><p className="text-sm text-[#617085]">{t.noTreat}</p></Card>}
      {m && (
        <Card title={t.yourPay}>
          <Row a={t.paid} b={`${money(m.paid)} ETB`} />
          <Row a={t.toPay} b={`${money(m.to_pay)} ETB`} bad={Number(m.to_pay) > 0} />
        </Card>
      )}
      {me.settings.welcome_note && <Card title={t.fromClinic}><p className="text-sm">{me.settings.welcome_note}</p></Card>}
      <p className="text-center text-xs text-[#617085]">{me.clinic.name}{me.clinic.phone ? ` · ${me.clinic.phone}` : ""}</p>
    </>
  );
}

function Row({ a, b, bad }: { a: ReactNode; b: ReactNode; bad?: boolean }) {
  return <div className="flex items-baseline justify-between gap-2.5 border-b border-dashed border-[#dbe5ee] py-1.5 text-sm last:border-0"><span>{a}</span><b style={bad ? { color: "#A32D2D" } : undefined}>{b}</b></div>;
}

function Treatment({ me, t }: { me: PortalMe; t: (typeof T)[Lang] }) {
  if (!me.treatments.length) return <Card><p className="text-sm text-[#617085]">{t.noTreat}</p></Card>;
  return (
    <>
      {me.treatments.map((x, i) => (
        <Card key={`${x.title}-${i}`}>
          <div className="flex items-center justify-between"><b>{x.title}{x.tooth ? ` · ${x.tooth}` : ""}</b>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${x.status === "completed" ? "bg-[#EAF3DE] text-[#3B6D11]" : "bg-[#E6F1FB] text-[#185FA5]"}`}>{x.status === "completed" ? t.finished : t.inprog}</span></div>
          <Bar pct={pct(x)} />
          <ul>
            {x.visits.map((v) => (
              <li key={v.seq} className="flex gap-2.5 border-b border-dashed border-[#dbe5ee] py-2 text-[13.5px] last:border-0">
                <i aria-hidden className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${v.status === "done" ? "border-[#3B6D11] bg-[#3B6D11]" : "border-[#b9c6d4]"}`} />
                <div><b>{t.visit} {v.seq} · {day(v.date, { day: "numeric", month: "short" })}</b><br /><span className="text-[#617085]">{v.what}{v.status === "done" ? ` — ${t.done}` : ""}</span></div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}

function Payments({ me, t }: { me: PortalMe; t: (typeof T)[Lang] }) {
  const m = me.money!;
  const tile = (bg: string, label: string, v: string, c?: string) => (
    <div className="rounded-2xl p-3" style={{ background: bg }}><small className="block text-[11px] text-[#617085]">{label}</small><b className="text-xl" style={c ? { color: c } : undefined}>{money(v)}</b><small className="block text-[11px] text-[#617085]">ETB</small></div>
  );
  return (
    <>
      <Card title={t.summary}>
        <div className="grid grid-cols-2 gap-2.5">
          {tile("#EAF3DE", t.paid, m.paid)}
          {tile("#FCEBEB", t.toPay, m.to_pay, "#A32D2D")}
          {m.unbilled != null && Number(m.unbilled) > 0 && (
            <div className="col-span-2 rounded-2xl bg-[#FFF3E0] p-3"><small className="block text-[11px] text-[#617085]">{t.unbilled}</small><b className="text-xl">{money(m.unbilled)} ETB</b>
              <div className="mt-1 text-xs text-[#617085]">{t.unbilledHelp}</div></div>
          )}
        </div>
      </Card>
      <Card title={t.receipts}>
        {!me.receipts?.length && <p className="text-sm text-[#617085]">{t.noReceipts}</p>}
        {me.receipts?.map((r) => (
          <Row key={r.no} a={<>RCP-{String(r.no).padStart(6, "0")} · {day(r.date, { day: "numeric", month: "short" })}<br /><small className="text-[#617085]">{r.what}{r.method ? ` · ${r.method}` : ""}</small></>} b={money(r.amount)} />
        ))}
      </Card>
      {me.treatments.filter((x) => x.planned && Number(x.planned) > 0).map((x, i) => (
        <Card key={i} title={t.plan}>
          <div className="text-[13.5px]">{x.title}: {money(x.planned)} ETB · {x.of} {t.visits}<Bar pct={Number(x.planned) ? (Number(x.collected) / Number(x.planned)) * 100 : 0} />{t.paid} {money(x.collected)}</div>
        </Card>
      ))}
    </>
  );
}

function Teeth({ me, t }: { me: PortalMe; t: (typeof T)[Lang] }) {
  const state = useMemo(() => fromItems(me.chart?.items), [me.chart]);
  const positions = me.chart?.positions ?? {};
  const [mode, setMode] = useState<"2d" | "3d">("2d");
  const [n, setN] = useState(0);
  const child = (me.chart?.items ?? []).some((i) => i.tooth >= 50) && !(me.chart?.items ?? []).some((i) => i.tooth < 50);
  const lines = n ? items(state, n, me.today) : [];
  return (
    <>
      {me.settings.show_3d && (
        <div role="group" className="mb-2.5 inline-flex overflow-hidden rounded-xl border border-[#dbe5ee] bg-white text-sm">
          {(["2d", "3d"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)} className={`px-4 py-2 ${mode === k ? "bg-[#E6F1FB] font-bold text-[#1F4E79]" : "text-[#617085]"}`}>{k === "2d" ? t.chart2d : t.chart3d}</button>
          ))}
        </div>
      )}
      <div className="rounded-2xl bg-[#F2F7FB] p-1.5 ring-1 ring-[#dbe5ee]">
        {mode === "2d" || !me.settings.show_3d ? (
          <div className="ta-chart-scroll"><AnatomicalChart dentition={child ? "child" : "adult"} state={state} positions={positions} today={me.today} selected={n} onSelect={setN} /></div>
        ) : (
          <Suspense fallback={<p className="p-6 text-center text-sm text-[#617085]">{t.wait}</p>}>
            <Dental3D state={state} positions={positions} sel={n} today={me.today} mode={child ? "child" : "adult"} xray={false} nums view="front" onSelect={setN} onCustomView={() => undefined} height="340px" />
          </Suspense>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-3 text-xs text-[#617085]">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#8a9bab]" />{t.inMouth}</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#E24B4A]" />{t.planned}</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-[#3B6D11]" />{t.doneRecently}</span>
      </div>
      <div className="mt-3 rounded-xl border-l-4 border-[#148F77] bg-white p-3 text-[13px]" aria-live="polite">
        {n === 0 ? <><b className="block">{t.tapTooth}</b>{t.tapHelp}</> : (
          <><b className="block">{t.tooth} {n} · {toothName(n)}</b>
            {lines.length ? lines.map((l) => <div key={l.key}>{l.t} — {SL[l.s]}</div>) : t.healthy}</>
        )}
      </div>
    </>
  );
}
