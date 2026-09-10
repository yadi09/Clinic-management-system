import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { AppError } from "@/lib/api-client";
import { toEthiopian } from "@/lib/ethiopian";
import { dialHref, dialLabel, getCampaign, signUp, type CampaignView } from "@/features/campaign/api";
import "@/features/campaign/campaign.css";

/**
 * The wide net.
 *
 * This is the link sent to every dental clinic we can find; the quiz and the
 * wheel come later, to the ones we invite. So it asks for what a first
 * conversation needs — who to call, where they are, and what the practice is
 * made of — and nothing else. Every extra field here is a clinic that closes
 * the tab.
 */

/** The parts a dental clinic is built from, as a dentist would say them. Ticking
 *  these gives us something countable; the box underneath gives them room to say
 *  what a list of chips never could. */
const PARTS = [
  "Reception desk",
  "Cashier",
  "One dentist",
  "Two or more dentists",
  "One chair",
  "Two or more chairs",
  "X-ray on site",
  "Dental lab on site",
  "We send lab work out",
  "Pharmacy",
  "More than one branch",
  "We still use paper cards",
];

export function CampaignRegisterPage() {
  const { code = "" } = useParams();
  const [view, setView] = useState<CampaignView | null>(null);
  const [gone, setGone] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [owner, setOwner] = useState("");
  const [tel, setTel] = useState("");
  const [clinic, setClinic] = useState("");
  const [place, setPlace] = useState("");
  const [structure, setStructure] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [website, setWebsite] = useState(""); // honeypot

  const load = useCallback(() => {
    getCampaign(code).then(setView).catch(() => setGone(true));
  }, [code]);
  useEffect(() => { load(); }, [load]);

  const toggle = (p: string) =>
    setPicked((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));

  const ready = owner.trim() && tel.trim() && clinic.trim() && place.trim();
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setErr(null);
    try {
      await signUp(code, {
        owner_name: owner.trim(), phone: tel.trim(), clinic_name: clinic.trim(),
        location: place.trim(), structure: structure.trim(), facilities: picked, website,
      });
      setDone(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setErr(e instanceof AppError ? e.message : "Something went wrong. Try once more.");
      setBusy(false);
    }
  };

  if (gone) {
    return (
      <div className="enk"><main className="enk-wrap" style={{ padding: "3rem 1.25rem" }}>
        <div className="enk-card"><h2>This link is not valid</h2>
          <p className="muted">Check the message we sent you, or ask us for a new one.</p></div>
      </main></div>
    );
  }

  const ec = toEthiopian(new Date());
  const arriving = ec.month === 13 ? ec.year + 1 : ec.year;

  return (
    <div className="enk">
      <header className={`enk-hero${done ? " small" : ""}`}>
        <span className="enk-year">እንኳን አደረሳችሁ · {arriving} ዓ.ም</span>
        <h1 className="am">{view?.title ?? "መልካም አዲስ ዓመት"}</h1>
        {!done && (
          <p className="sub">
            Three dental clinics start the new year with the whole system installed, free.
            Put your clinic's name in before Meskel.
          </p>
        )}
      </header>

      <main className="enk-wrap" style={{ padding: "0 1.25rem 4rem" }}>
        <div style={{ marginTop: done ? "1.2rem" : "-2.2rem", position: "relative", zIndex: 1 }}>
          {done ? (
            <div className="enk-gift" style={{ textAlign: "center" }}>
              <p className="am" style={{ fontSize: "1.5rem", margin: 0 }}>እናመሰግናለን!</p>
              <h2 style={{ marginTop: ".4rem" }}>{clinic.trim()} is on the list</h2>
              <p className="muted">
                We will call you on <b>{tel.trim()}</b> to show you the system and send you what you
                need to take part. Nothing else to do for now.
              </p>
              <p className="tiny muted" style={{ marginTop: "1rem" }}>
                Sent the wrong details? Fill the form in again with the same number and it replaces
                what we have.
              </p>
              <button className="enk-btn ghost" style={{ marginTop: "1rem" }}
                onClick={() => { setDone(false); setBusy(false); }}>
                Change something
              </button>
            </div>
          ) : (
            <>
              <div className="enk-gift">
                <h2 style={{ margin: 0 }}>{view?.gift_label ?? "Complete dental clinic system — implemented free"}</h2>
                <p className="muted" style={{ margin: ".4rem 0 0" }}>
                  {view?.gift_detail ?? "Installed at your clinic, your records brought across, your team trained. Yours to keep."}
                </p>
                <p className="tiny muted" style={{ marginTop: ".8rem" }}>
                  Every clinic that takes part gets a New Year offer. Three get the whole thing free.
                </p>
              </div>

              <div className="enk-card" style={{ marginTop: "1rem" }}>
                <h2>Put your clinic forward</h2>
                <p className="muted" style={{ marginTop: ".2rem" }}>
                  Four things and a sentence about your clinic. We will call you, show you how it
                  works, and send you what you need to take part.
                </p>

                <div style={{ marginTop: "1.3rem" }}>
                  <label className="enk-field"><span>Your name</span>
                    <input value={owner} onChange={(e) => setOwner(e.target.value)} autoComplete="name"
                      placeholder="Dr. Sara Ahmed" /></label>
                  <label className="enk-field"><span>Phone</span>
                    <input value={tel} onChange={(e) => setTel(e.target.value)} inputMode="tel"
                      autoComplete="tel" placeholder="09…" /></label>
                  <label className="enk-field"><span>Clinic name</span>
                    <input value={clinic} onChange={(e) => setClinic(e.target.value)}
                      autoComplete="organization" placeholder="Adey Dental Clinic" /></label>
                  <label className="enk-field"><span>Where is it?</span>
                    <input value={place} onChange={(e) => setPlace(e.target.value)}
                      placeholder="Bole, Addis Ababa — near Edna Mall" /></label>

                  <div className="enk-field">
                    <span>What is your clinic made of?</span>
                    <p className="tiny muted" style={{ margin: "0 0 .6rem" }}>
                      Tap whatever is true. It tells us what to show you.
                    </p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: ".45rem" }}>
                      {PARTS.map((p) => (
                        <button key={p} type="button" onClick={() => toggle(p)}
                          className={`enk-chip${picked.includes(p) ? " on" : ""}`}>{p}</button>
                      ))}
                    </div>
                  </div>

                  <label className="enk-field"><span>Anything else about how the clinic runs</span>
                    <textarea value={structure} onChange={(e) => setStructure(e.target.value)} rows={4}
                      placeholder="We have a reception, two dentists and one chair. The cashier writes receipts by hand and we keep paper cards in a cupboard." />
                  </label>

                  <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }} />

                  {err && <p style={{ color: "var(--tibeb-red)", fontSize: ".9rem" }}>{err}</p>}
                  <button className="enk-btn gold" disabled={!ready || busy} onClick={submit}>
                    {busy ? "Sending…" : "Put my clinic forward"}
                  </button>
                  <p className="tiny muted" style={{ textAlign: "center", marginTop: ".7rem" }}>
                    Your number is used to call you about this campaign. Nothing else.
                  </p>
                </div>
              </div>
            </>
          )}

          {(view?.telegram || view?.phone) && (
            <div style={{ marginTop: "2rem", textAlign: "center" }}>
              <p className="tiny muted" style={{ marginBottom: ".6rem" }}>Would rather just talk to someone?</p>
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
          )}
        </div>
      </main>
    </div>
  );
}
