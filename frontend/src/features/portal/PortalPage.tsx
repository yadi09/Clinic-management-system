// The patient's own page, at /p/<clinic>. No staff account: the patient types the card
// number printed on their patient card and sees their treatment, payments and teeth.
//
// Built for a phone held in one hand. Sections sit side by side and slide (swipe, or
// tap a tab); English and Amharic are one switch, never both at once. Everything here
// is read-only — the server only ever returns this one patient's record.
import { useCallback, useEffect, useMemo, useState, type ReactNode, type TouchEvent } from "react";
import { useParams } from "react-router-dom";

import { AppError } from "@/lib/api-client";
import { portalLogin, portalLogo, portalMe, portalPayOptions, type PayOptions, type PortalMe, type PortalTreatment } from "@/features/portal/api";
import { PayFromHome } from "@/features/portal/PayFromHome";
import { PortalTeeth } from "@/features/portal/PortalTeeth";
import { T, type Lang } from "@/features/portal/text";


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
    <div lang={lang} style={LIGHT} className="min-h-dvh bg-[#F2F7FB] text-[#1f2a37]">
      <meta name="robots" content="noindex" />
      <div className="flex min-h-dvh flex-col">
        {!token || (!me && !gone) ? (
          <Login slug={slug} lang={lang} setLang={setLang} onDone={signedIn} loading={!!token} />
        ) : gone || !me ? (
          <div className="p-8 text-center text-sm" role="alert">{t.offline}
            <button type="button" className="mt-4 block w-full rounded-xl bg-[#148F77] p-3 font-bold text-white" onClick={() => { setGone(false); load(token); }}>{t.retry}</button></div>
        ) : (
          <App me={me} slug={slug} token={token} lang={lang} setLang={setLang} onSignOut={signOut} onReload={() => load(token)} />
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
    catch (e) { setErr(e instanceof AppError && e.status === 429 ? t.slow : e instanceof AppError && e.code === "PORTAL_OFF" ? t.notOpen : e instanceof AppError && e.status === 401 ? t.noCard : t.offline); setBusy(false); }
  };
  return (
    <div className="flex flex-1 flex-col" style={{ background: "linear-gradient(180deg,#1F4E79 0,#1F4E79 300px,#F2F7FB 300px)" }}>
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3.5 px-6 pb-8 pt-4">
        <div className="flex justify-end"><LangSwitch lang={lang} setLang={setLang} /></div>
        <div className="mb-1.5 mt-8 text-center text-white">
          <div className="mx-auto mb-3 w-fit"><Logo slug={slug} name={slug} has size={72} /></div>
          <h1 className="m-0 text-2xl font-bold capitalize !text-white">{slug.replace(/-/g, " ")}</h1>
          <p className="mt-1 text-sm opacity-85">{t.welcome}</p>
        </div>
        <form className="rounded-[18px] bg-white p-6 shadow-lg" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label htmlFor="card" className="mb-1.5 block text-xs text-[#617085]">{t.cardno}</label>
          <input id="card" value={card} onChange={(e) => setCard(e.target.value)} autoComplete="off" autoCapitalize="characters" inputMode="text"
            placeholder="P000123" className="w-full rounded-xl border-[1.5px] border-[#dbe5ee] p-3 text-lg tracking-wide outline-none focus:border-[#148F77]" />
          <p role="alert" className="mt-2 min-h-4 text-xs text-[#b4322f]">{err}</p>
          <button type="submit" disabled={busy || loading} className="mt-3 w-full rounded-xl bg-[#148F77] p-3.5 text-[15px] font-bold text-white disabled:opacity-60">{busy || loading ? t.wait : t.see}</button>
        </form>
        <p className="text-center text-xs text-[#617085]">{t.findcard}</p>
      </div>
    </div>
  );
}

/* ------------------------------------ the app ------------------------------------ */

type Tab = "home" | "treat" | "pay" | "teeth";

function App({ me, slug, token, lang, setLang, onSignOut, onReload }: { me: PortalMe; slug: string; token: string; lang: Lang; setLang: (l: Lang) => void; onSignOut: () => void; onReload: () => void }) {
  const t = T[lang];
  const s = me.settings;
  // What the patient could pay, and what is still waiting. Only when the clinic allows paying.
  const [opts, setOpts] = useState<PayOptions | null>(null);
  const [paying, setPaying] = useState(false);
  const loadOpts = useCallback(() => {
    if (!s.allow_pay || !s.show_money) return;
    portalPayOptions(slug, token).then(setOpts).catch(() => setOpts(null));
  }, [slug, token, s.allow_pay, s.show_money]);
  useEffect(loadOpts, [loadOpts]);
  const changed = useCallback(() => { onReload(); loadOpts(); }, [onReload, loadOpts]);
  const tabs = useMemo(() => [
    { k: "home" as Tab, label: t.home }, { k: "treat" as Tab, label: t.treat },
    ...(s.show_money ? [{ k: "pay" as Tab, label: t.pay }] : []),
    ...(s.show_teeth && me.chart ? [{ k: "teeth" as Tab, label: t.teeth }] : []),
  ], [t, s.show_money, s.show_teeth, me.chart]);
  const [idx, setIdx] = useState(0);
  const go = (i: number) => setIdx(Math.max(0, Math.min(tabs.length - 1, i)));
  // On a phone the sections also slide: swipe left or right to move between them.
  const [touch, setTouch] = useState<{ x: number; y: number } | null>(null);
  const onStart = (e: TouchEvent) => setTouch({ x: e.touches[0]!.clientX, y: e.touches[0]!.clientY });
  const onEnd = (e: TouchEvent) => {
    if (!touch) return;
    const dx = e.changedTouches[0]!.clientX - touch.x, dy = e.changedTouches[0]!.clientY - touch.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 45) go(idx + (dx < 0 ? 1 : -1));
    setTouch(null);
  };
  const active = tabs[Math.min(idx, tabs.length - 1)]!;

  return (
    <>
      <header className="bg-[#1F4E79] text-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 pb-3 pt-3.5 md:px-6 md:py-4">
          <Logo slug={me.clinic.slug} name={me.clinic.name} has={me.clinic.has_logo} size={44} />
          <div className="min-w-0"><div className="truncate text-base font-bold leading-tight !text-white md:text-lg">{me.clinic.name}</div><div className="text-[11px] opacity-75 md:text-xs">{t.portal}</div></div>
          <div className="ml-auto flex shrink-0 items-center gap-2.5 md:gap-3"><LangSwitch lang={lang} setLang={setLang} />
            <button type="button" onClick={onSignOut} className="whitespace-nowrap text-[12px] underline opacity-80">{t.out}</button></div>
        </div>
      </header>
      <div role="tablist" className="sticky top-0 z-10 border-b border-[#dbe5ee] bg-white">
        <div className="mx-auto flex max-w-6xl px-2 md:px-6">
          {tabs.map((x, i) => (
            <button key={x.k} role="tab" type="button" aria-selected={active.k === x.k} onClick={() => go(i)}
              className={`flex-1 border-b-[3px] px-1 pb-2.5 pt-3 text-[13px] md:flex-none md:px-6 md:text-[15px] ${active.k === x.k ? "border-[#148F77] font-bold text-[#1F4E79]" : "border-transparent text-[#617085] hover:text-[#1F4E79]"}`}>{x.label}</button>
          ))}
        </div>
      </div>
      <main className="flex-1" onTouchStart={onStart} onTouchEnd={onEnd}>
        <section role="tabpanel" aria-label={active.label} className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 md:px-6 md:pt-7">
          {active.k === "home" && <Home me={me} t={t} />}
          {active.k === "treat" && <Treatment me={me} t={t} />}
          {active.k === "pay" && <Payments me={me} t={t} opts={opts} onPay={() => setPaying(true)} />}
          {active.k === "teeth" && <PortalTeeth me={me} t={t} />}
        </section>
      </main>
      <div className="border-t border-[#dbe5ee] bg-white p-1.5 text-center text-[11px] text-[#617085] md:hidden">{t.swipe}</div>
      {paying && opts && <PayFromHome slug={slug} token={token} opts={opts} t={t} phone={me.clinic.phone} onClose={() => { setPaying(false); changed(); }} onChanged={changed} />}
    </>
  );
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return <div className="rounded-2xl bg-white p-4 shadow-sm md:p-5">{title && <h3 className="mb-2.5 text-[12.5px] font-semibold text-[#617085] md:text-[13px]">{title}</h3>}{children}</div>;
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
      <h2 className="m-0 text-[22px] font-extrabold md:text-[28px]">{t.hello} {me.first_name}</h2>
      <p className="mb-5 mt-1 text-[13px] text-[#617085] md:text-[15px]">{t.homesub}</p>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
      </div>
      <p className="mt-6 text-center text-xs text-[#617085]">{me.clinic.name}{me.clinic.phone ? ` · ${me.clinic.phone}` : ""}</p>
    </>
  );
}

function Row({ a, b, bad }: { a: ReactNode; b: ReactNode; bad?: boolean }) {
  return <div className="flex items-baseline justify-between gap-2.5 border-b border-dashed border-[#dbe5ee] py-1.5 text-sm last:border-0"><span>{a}</span><b style={bad ? { color: "#A32D2D" } : undefined}>{b}</b></div>;
}

function Treatment({ me, t }: { me: PortalMe; t: (typeof T)[Lang] }) {
  if (!me.treatments.length) return <Card><p className="text-sm text-[#617085]">{t.noTreat}</p></Card>;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
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
    </div>
  );
}

function Payments({ me, t, opts, onPay }: { me: PortalMe; t: (typeof T)[Lang]; opts: PayOptions | null; onPay: () => void }) {
  const m = me.money!;
  const canPay = !!opts && opts.items.some((i) => i.payable) && opts.rails.length > 0;
  const tile = (bg: string, label: string, v: string, c?: string) => (
    <div className="rounded-2xl p-3" style={{ background: bg }}><small className="block text-[11px] text-[#617085]">{label}</small><b className="text-xl" style={c ? { color: c } : undefined}>{money(v)}</b><small className="block text-[11px] text-[#617085]">ETB</small></div>
  );
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      {me.settings.allow_pay && opts && (
        <Card title={t.payHome}>
          <p className="text-[13.5px] text-[#617085]">{!opts.rails.length ? t.payNoRail : !opts.items.some((i) => i.payable) ? t.payNothing : t.payHomeSub}</p>
          <button type="button" disabled={!canPay} onClick={onPay} className="mt-3 w-full rounded-xl bg-[#148F77] p-3.5 text-[15px] font-bold text-white disabled:opacity-50">{t.payNow}</button>
        </Card>
      )}
      {!!opts?.open.length && (
        <Card title={t.waiting}>
          {opts.open.map((o) => (
            <Row key={o.id} a={<>{money(o.amount)} ETB · {o.reference.toUpperCase()}<br /><small className="text-[#617085]">{o.rail}</small></>}
              b={<span className="rounded-full bg-[#FFF3E0] px-2.5 py-0.5 text-[11px] font-bold text-[#B5651D]">{t.stChecking}</span>} />
          ))}
        </Card>
      )}
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
    </div>
  );
}
