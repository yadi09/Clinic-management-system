import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { AppError } from "@/lib/api-client";
import { toEthiopian } from "@/lib/ethiopian";
import { Wheel, segmentsFor, type Segment } from "@/features/campaign/Wheel";
import {
  dialHref, dialLabel,
  answerQuestion, campaignQuestions, enterCampaign, getCampaign, resumeCampaign, spinWheel,
  type AnswerResult, type CampaignQuestion, type CampaignView, type SpinResult,
} from "@/features/campaign/api";
import "@/features/campaign/campaign.css";

/** Where the clinic's place in the draw is kept, so a refresh — or a phone that
 *  went through a tunnel — does not cost them their turn. */
const tokenKey = (code: string) => `enk.${code}`;

type Stage = "intro" | "register" | "quiz" | "ready" | "result";

export function CampaignPage() {
  const { code = "" } = useParams();
  const [view, setView] = useState<CampaignView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [token, setToken] = useState<string>(() => localStorage.getItem(tokenKey(code)) ?? "");
  const [stage, setStage] = useState<Stage>("intro");
  const [result, setResult] = useState<SpinResult | null>(null);
  const [name, setName] = useState("");

  const refresh = useCallback(() => {
    getCampaign(code).then(setView).catch((e) => setLoadErr(e instanceof AppError ? e.message : "This link is not valid."));
  }, [code]);

  useEffect(() => { refresh(); }, [refresh]);

  // Pick the clinic up wherever it stopped.
  useEffect(() => {
    if (!token) return;
    resumeCampaign(code, token)
      .then((e) => {
        setName(e.full_name);
        if (e.spun) {
          setResult({ won: e.won, prize_label: e.prize_label ?? "", slot_index: 0, waiting: false });
          setStage("result");
        } else setStage(e.quiz_done ? "ready" : "quiz");
      })
      .catch(() => {
        localStorage.removeItem(tokenKey(code));
        setToken("");
      });
  }, [code, token]);

  if (loadErr) return <Shell><div className="enk-card"><h2>This link is not valid</h2><p className="muted">Check the message we sent you, or ask us for a new one.</p></div></Shell>;
  if (!view) return <Shell><div className="enk-card"><p className="muted">Loading…</p></div></Shell>;

  return (
    <div className="enk">
      <Hero view={view} small={stage !== "intro" && view.status === "open"} />
      <main className="enk-wrap" style={{ padding: "0 1.25rem 4rem" }}>
        <div style={{ marginTop: stage === "intro" ? "-2.2rem" : "1.2rem", position: "relative", zIndex: 1 }}>
          {view.status === "draft" && <Card><h2>Opening soon</h2><p className="muted">This page is not open yet. We will send you the word.</p></Card>}
          {view.status === "closed" && <Closed view={view} />}
          {view.status === "open" && (
            <>
              {stage === "intro" && <Intro view={view} onReady={() => setStage("register")} />}
              {stage === "register" && (
                <Register code={code} onDone={(t, who) => { localStorage.setItem(tokenKey(code), t); setName(who); setToken(t); setStage("quiz"); }} />
              )}
              {stage === "quiz" && <Quiz code={code} token={token} name={name} onDone={() => setStage("ready")} />}
              {stage === "ready" && (
                <Spin code={code} token={token} view={view} onResult={(r) => { setResult(r); setStage("result"); refresh(); }} />
              )}
              {stage === "result" && result && <Result view={view} result={result} name={name} />}
            </>
          )}
        </div>
        <Contact view={view} />
      </main>
    </div>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="enk"><main className="enk-wrap" style={{ padding: "3rem 1.25rem" }}>{children}</main></div>
);
const Card = ({ children }: { children: React.ReactNode }) => <div className="enk-card">{children}</div>;

function Hero({ view, small }: { view: CampaignView; small?: boolean }) {
  // "እንኳን አደረሳችሁ" congratulates you on *arriving* at the year, so it has to name
  // the year being arrived at. Through Pagume — the thirteenth month, the five
  // days before Meskerem 1 — that is next year, not the one we are standing in.
  const ec = toEthiopian(new Date());
  const arriving = ec.month === 13 ? ec.year + 1 : ec.year;
  return (
    <header className={`enk-hero${small ? " small" : ""}`}>
      <Petals />
      <span className="enk-year">እንኳን አደረሳችሁ · {arriving} ዓ.ም</span>
      <h1 className="am">{view.title}</h1>
      {!small && view.subtitle && <p className="sub">{view.subtitle}</p>}
      {!small && <div style={{ marginTop: "1.8rem" }}><Adey /></div>}
    </header>
  );
}

/** The Adey Abeba, drawn rather than fetched: eight petals and a sun. */
function Adey({ size = 54, spin = 0 }: { size?: number; spin?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" aria-hidden="true" style={{ transform: `rotate(${spin}deg)` }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <ellipse key={i} cx="30" cy="15" rx="5.4" ry="12.5" fill="#f5c518"
          transform={`rotate(${i * 45} 30 30)`} opacity={0.95} />
      ))}
      <circle cx="30" cy="30" r="7" fill="#ff9e1b" />
      <circle cx="30" cy="30" r="3" fill="#b46a00" />
    </svg>
  );
}

function Petals() {
  // Deterministic, so the page does not reflow differently on every render.
  const petals = useMemo(
    () => Array.from({ length: 7 }).map((_, i) => ({
      left: `${(i * 13 + 6) % 92}%`, delay: `${(i * 2.3) % 11}s`,
      dur: `${13 + (i % 4) * 4}s`, size: 11 + (i % 3) * 4,
    })), []);
  return (
    <div aria-hidden="true" className="enk-petals">
      {petals.map((p, i) => (
        <div key={i} className="enk-petal" style={{ left: p.left, animationDelay: p.delay, animationDuration: p.dur }}>
          <Adey size={p.size} spin={i * 40} />
        </div>
      ))}
    </div>
  );
}

function Odds({ view }: { view: CampaignView }) {
  return (
    <p className="tiny muted" style={{ marginTop: ".8rem" }}>
      <b>{view.gifts_left}</b> of {view.gifts} still unclaimed · <b>{view.chances_left}</b> chances left of {view.chances}
      {view.played > 0 && <> · {view.played} {view.played === 1 ? "clinic has" : "clinics have"} played</>}
    </p>
  );
}

function Intro({ view, onReady }: { view: CampaignView; onReady: () => void }) {
  const closes = view.closes_at ? new Date(view.closes_at) : null;
  return (
    <>
      <div className="enk-gift">
        <div style={{ display: "flex", gap: ".8rem", alignItems: "flex-start" }}>
          <Adey size={40} />
          <div>
            <h2 style={{ margin: 0 }}>{view.gift_label}</h2>
            {view.gift_detail && <p className="muted" style={{ margin: ".4rem 0 0" }}>{view.gift_detail}</p>}
          </div>
        </div>
        <Odds view={view} />
      </div>

      <div className="enk-card" style={{ marginTop: "1rem" }}>
        <h2>How it works</h2>
        <ol className="muted" style={{ paddingLeft: "1.1rem", margin: ".6rem 0 0", lineHeight: 1.9 }}>
          <li>Watch the short video and read the page we sent you.</li>
          <li>Answer a few questions about the system — <b>this is not a test</b>. Get one wrong and we tell you the answer and why, then ask again.</li>
          <li>Spin once. Every clinic that finishes wins something; three win the whole system.</li>
        </ol>
        <p className="tiny muted" style={{ marginTop: "1rem", borderTop: "1px solid var(--line)", paddingTop: ".9rem" }}>
          Nobody is ranked and nobody is compared. The questions exist so that you leave this page
          knowing what the software does — that is the only thing we want from your five minutes.
        </p>
      </div>

      {closes && (
        <p className="tiny muted" style={{ textAlign: "center", marginTop: "1rem" }}>
          Closes {closes.toLocaleDateString(undefined, { day: "numeric", month: "long" })} · Meskel
        </p>
      )}

      <div style={{ marginTop: "1.2rem" }}>
        <button className="enk-btn gold" onClick={onReady}>I've seen the video — I'm ready</button>
      </div>
      <p className="tiny muted" style={{ textAlign: "center", marginTop: ".7rem" }}>
        Three fields and about five minutes.
      </p>
    </>
  );
}

function Register({ code, onDone }: { code: string; onDone: (token: string, name: string) => void }) {
  const [full, setFull] = useState("");
  const [tel, setTel] = useState("");
  const [clinic, setClinic] = useState("");
  const [website, setWebsite] = useState(""); // honeypot
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = full.trim() && tel.trim() && clinic.trim();

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true); setErr(null);
    try {
      const e = await enterCampaign(code, { full_name: full.trim(), phone: tel.trim(), clinic_name: clinic.trim(), website });
      onDone(e.token ?? "", e.full_name);
    } catch (e) {
      setErr(e instanceof AppError ? e.message : "Something went wrong. Try once more.");
      setBusy(false);
    }
  };

  return (
    <div className="enk-card">
      <h2>Who are you?</h2>
      <p className="muted" style={{ marginTop: ".2rem" }}>Three things, so we know who to call if you win.</p>
      <div style={{ marginTop: "1.2rem" }}>
        <label className="enk-field"><span>Your name</span>
          <input value={full} onChange={(e) => setFull(e.target.value)} autoComplete="name" /></label>
        <label className="enk-field"><span>Phone</span>
          <input value={tel} onChange={(e) => setTel(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="09…" /></label>
        <label className="enk-field"><span>Clinic name</span>
          <input value={clinic} onChange={(e) => setClinic(e.target.value)} autoComplete="organization"
            onKeyDown={(e) => e.key === "Enter" && submit()} /></label>
        {/* Left here for the bots. A person never sees it. */}
        <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={website}
          onChange={(e) => setWebsite(e.target.value)}
          style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }} />
        {err && <p style={{ color: "var(--tibeb-red)", fontSize: ".9rem" }}>{err}</p>}
        <button className="enk-btn" disabled={!ok || busy} onClick={submit}>{busy ? "One moment…" : "Start the questions"}</button>
      </div>
    </div>
  );
}

function Quiz({ code, token, name, onDone }: { code: string; token: string; name: string; onDone: () => void }) {
  const [qs, setQs] = useState<CampaignQuestion[] | null>(null);
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [res, setRes] = useState<AnswerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => { campaignQuestions(code, token).then(setQs).catch(() => setQs([])); }, [code, token]);

  if (!qs) return <div className="enk-card"><p className="muted">Loading the questions…</p></div>;
  if (qs.length === 0) return <div className="enk-card"><p className="muted">No questions yet.</p></div>;

  const q = qs[at];

  const choose = async (i: number) => {
    if (busy || res?.correct) return;
    setBusy(true); setPicked(i);
    try {
      const r = await answerQuestion(code, token, q.id, i);
      setRes(r);
    } finally { setBusy(false); }
  };

  const next = () => {
    setPicked(null); setRes(null);
    if (at + 1 >= qs.length) onDone();
    else { setAt(at + 1); top.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  };

  return (
    <div className="enk-card" ref={top}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: ".7rem" }}>
        <span className="tiny muted">Question {at + 1} of {qs.length}</span>
        {name && <span className="tiny muted">{name}</span>}
      </div>
      {/* The tibeb weaves itself, one band per question answered. */}
      <div className="enk-progress" aria-hidden="true">
        {qs.map((_, i) => (
          <i key={i} className={i < at ? "on enk-tibeb" : ""} />
        ))}
      </div>

      <h2 style={{ marginTop: "1.1rem" }}>{q.prompt}</h2>

      <div style={{ marginTop: "1rem" }}>
        {q.choices.map((label, i) => {
          const state = res && picked === i ? (res.correct ? "right" : "wrong") : "";
          return (
            <button key={i} className={`enk-choice ${state}`} onClick={() => choose(i)}
              disabled={busy || !!res?.correct}>
              <span className="k">{String.fromCharCode(65 + i)}</span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {res && !res.correct && (
        <>
          <div className="enk-explain">
            <p style={{ margin: 0 }}><b>Not quite.</b> {res.explain}</p>
          </div>
          <button className="enk-btn ghost" onClick={() => { setPicked(null); setRes(null); }}>Try again</button>
        </>
      )}
      {res?.correct && (
        <>
          <div className="enk-explain enk-teaches">
            <p style={{ margin: 0 }}><b>That's it.</b> {res.teaches}</p>
          </div>
          <button className="enk-btn" onClick={next}>{at + 1 >= qs.length ? "Finished — take me to the wheel" : "Next question"}</button>
        </>
      )}
    </div>
  );
}

function Spin({ code, token, view, onResult }: { code: string; token: string; view: CampaignView; onResult: (r: SpinResult) => void }) {
  const segments = useMemo<Segment[]>(
    () => segmentsFor(view.gifts, view.chances, "Free", view.prizes), [view]);
  const [spinning, setSpinning] = useState(false);
  const [land, setLand] = useState<number | null>(null);
  const pending = useRef<SpinResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const go = async () => {
    if (spinning) return;
    setSpinning(true); setErr(null);
    try {
      const r = await spinWheel(code, token);
      pending.current = r;
      if (r.waiting) { onResult(r); return; }
      const i = r.won ? 0 : Math.max(1, segments.findIndex((s) => s.label === r.prize_label));
      setLand(i);
    } catch (e) {
      setErr(e instanceof AppError ? e.message : "The wheel did not turn. Try again.");
      setSpinning(false);
    }
  };

  return (
    <div className="enk-card" style={{ textAlign: "center" }}>
      <h2>Your turn</h2>
      <p className="muted" style={{ marginTop: ".2rem" }}>One spin. Every clinic wins something.</p>
      <Wheel segments={segments} landOn={land} spinning={spinning}
        onRest={() => pending.current && onResult(pending.current)} />
      {err && <p style={{ color: "var(--tibeb-red)", fontSize: ".9rem" }}>{err}</p>}
      <button className="enk-btn gold" disabled={spinning} onClick={go} style={{ marginTop: "1rem" }}>
        {spinning ? "Turning…" : "Spin"}
      </button>
      <Odds view={view} />
      <Proof view={view} />
    </div>
  );
}

function Result({ view, result, name }: { view: CampaignView; result: SpinResult; name: string }) {
  if (result.waiting) {
    return (
      <div className="enk-card">
        <h2>Every chance has been taken</h2>
        <p className="muted">
          You finished the questions, and you are on the list — but the {view.chances} chances were
          claimed before you reached the wheel. We will call you: there is a New Year offer for you
          either way, and we would rather give it to you on the phone than let a full wheel decide it.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className={result.won ? "enk-gift" : "enk-card"} style={{ textAlign: "center" }}>
        <div style={{ display: "grid", placeItems: "center", marginBottom: ".6rem" }}><Adey size={result.won ? 64 : 44} /></div>
        {result.won ? (
          <>
            <p className="am" style={{ fontSize: "1.6rem", margin: 0 }}>እንኳን ደስ አለዎት!</p>
            <h2 style={{ marginTop: ".4rem" }}>{view.gift_label}</h2>
            <p className="muted">{view.gift_detail}</p>
            <p style={{ marginTop: "1rem" }}>
              {name ? `${name}, we` : "We"} will call you within two days to arrange the installation.
            </p>
          </>
        ) : (
          <>
            <h2 style={{ marginTop: 0 }}>{result.prize_label}</h2>
            {result.detail && <p className="muted">{result.detail}</p>}
            <p style={{ marginTop: "1rem" }}>
              This is yours for the whole of Meskerem. We will call you to set it up — and if any of the
              three gifts is still unclaimed when the draw closes, you are in that final draw too.
            </p>
          </>
        )}
      </div>
      <Proof view={view} />
    </>
  );
}

function Closed({ view }: { view: CampaignView }) {
  return (
    <div className="enk-card">
      <h2>The draw is closed</h2>
      <p className="muted">Thank you to every clinic that took part. The seed is published below — the whole wheel can be checked against it.</p>
      <Proof view={view} />
    </div>
  );
}

/**
 * The proof.
 *
 * A dental clinic has no reason to trust a company it met on Telegram last week.
 * So the wheel is decided before anyone plays, the commitment is published from
 * the first day, and the seed follows at the close — which turns "it was fair"
 * from something we assert into something anyone can check.
 */
function Proof({ view }: { view: CampaignView }) {
  const [open, setOpen] = useState(false);
  if (!view.seed_hash) return null;
  return (
    <div style={{ marginTop: "1.2rem", borderTop: "1px solid var(--line)", paddingTop: ".9rem", textAlign: "left" }}>
      <button className="tiny muted" onClick={() => setOpen(!open)}
        style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline" }}>
        {open ? "Hide" : "How do I know the wheel is fair?"}
      </button>
      {open && (
        <div className="tiny muted" style={{ marginTop: ".6rem", lineHeight: 1.7 }}>
          <p style={{ marginTop: 0 }}>
            Every position was decided before the campaign opened, by a secret number. The fingerprint of
            that number was published on this page from the first day and has not changed:
          </p>
          <code style={{ display: "block", wordBreak: "break-all", background: "var(--cotton-dim)", padding: ".5rem .6rem", borderRadius: "8px" }}>
            {view.seed_hash}
          </code>
          <p>
            When the draw closes we publish the number itself. Position <i>i</i> holds a gift if
            SHA-256 of <code>seed:i</code> is among the {view.gifts} lowest of the {view.chances}.
            Clinics take positions in the order they finish, so everyone's chance is the same —
            {" "}{view.gifts} in {view.chances} — however early or late they arrive.
          </p>
          {view.seed && (
            <>
              <p style={{ marginBottom: ".3rem" }}><b>The number, now the draw is closed:</b></p>
              <code style={{ display: "block", wordBreak: "break-all", background: "var(--cotton-dim)", padding: ".5rem .6rem", borderRadius: "8px" }}>
                {view.seed}
              </code>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Contact({ view }: { view: CampaignView }) {
  if (!view.telegram && !view.phone) return null;
  return (
    <div style={{ marginTop: "2rem", textAlign: "center" }}>
      <p className="tiny muted" style={{ marginBottom: ".6rem" }}>Stuck, or want to see it working first?</p>
      <div style={{ display: "flex", gap: ".6rem", justifyContent: "center", flexWrap: "wrap" }}>
        {view.telegram && (
          <a className="enk-btn ghost" style={{ width: "auto", padding: ".7rem 1.1rem", textDecoration: "none", display: "inline-block" }}
            href={`https://t.me/${view.telegram.replace(/^@/, "")}`} target="_blank" rel="noreferrer">
            Message us on Telegram
          </a>
        )}
        {view.phone && (
          <a className="enk-btn ghost" style={{ width: "auto", padding: ".7rem 1.1rem", textDecoration: "none", display: "inline-block" }}
            href={dialHref(view.phone)}>Call {dialLabel(view.phone)}</a>
        )}
      </div>
    </div>
  );
}
