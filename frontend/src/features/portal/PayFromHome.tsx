// Pay from home: the sheet a patient uses to pay what they owe (or the next visit ahead
// of time) from their own phone. Three steps — choose, pay and type the transaction
// number, then watch the bank check. The page never decides anything about money: it
// sends the patient's choices, and shows what the server says.
import { useEffect, useMemo, useRef, useState } from "react";

import { AppError } from "@/lib/api-client";
import { portalPay, portalPayStatus, type PayOptions, type PayStatus } from "@/features/portal/api";
import type { T, Lang } from "@/features/portal/text";

type Words = (typeof T)[Lang];
const money = (s: string | number) => Number(s).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function PayFromHome({ slug, token, opts, t, phone, onClose, onChanged }: {
  slug: string; token: string; opts: PayOptions; t: Words; phone?: string; onClose: () => void; onChanged: () => void;
}) {
  const payable = opts.items.filter((i) => i.payable);
  const [step, setStep] = useState<"choose" | "method" | "status">("choose");
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(payable.map((i) => [i.key, true])));
  const [railId, setRailId] = useState(opts.rails[0]?.id ?? "");
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [st, setSt] = useState<PayStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const chosen = useMemo(() => payable.filter((i) => picked[i.key]), [payable, picked]);
  const total = chosen.reduce((s, i) => s + Number(i.amount), 0);
  const rail = opts.rails.find((r) => r.id === railId);

  // While the bank is still working, ask again every few seconds — up to a minute.
  useEffect(() => {
    if (step !== "status" || st?.state !== "checking") return;
    let n = 0;
    const tick = () => {
      if (++n > 15) return;
      timer.current = setTimeout(() => {
        portalPayStatus(slug, token, st.id).then((x) => { setSt(x); if (x.state !== "checking") onChanged(); }).catch(() => tick());
      }, 4000);
    };
    tick();
    return () => clearTimeout(timer.current);
  }, [step, st, slug, token, onChanged]);

  const submit = async () => {
    if (!/^[A-Za-z0-9._/-]{6,40}$/.test(ref.trim())) { setErr(t.typeTxn); return; }
    setBusy(true); setErr("");
    try {
      const x = await portalPay(slug, token, { items: chosen.map((i) => i.key), rail_id: railId, reference: ref.trim() });
      setSt(x); setStep("status"); onChanged();
    } catch (e) {
      setErr(e instanceof AppError ? e.message : t.offline);
    }
    setBusy(false);
  };

  const state = st?.state;
  // Submitted is always done. Checking is done once the bank has answered, active while it
  // has not. The last step is the answer: confirmed, or not found.
  const steps: { label: string; look: "done" | "active" | "bad" | "idle"; n: number }[] = [
    { label: t.stSubmitted, look: "done", n: 1 },
    { label: t.stChecking, look: state === "paid" || state === "rejected" ? "done" : "active", n: 2 },
    { label: state === "rejected" ? t.stNotFound : t.stConfirmed, look: state === "paid" ? "done" : state === "rejected" ? "bad" : "idle", n: 3 },
  ];
  const LOOK = { done: "bg-[#3B6D11] text-white", active: "bg-[#148F77] text-white", bad: "bg-[#A32D2D] text-white", idle: "bg-[#e6eef5] text-[#617085]" };

  return (
    <div className="absolute inset-0 z-20 flex items-end bg-[#0f2437]/50" role="dialog" aria-modal="true" aria-label={t.payHome}>
      <div className="max-h-[92%] w-full overflow-y-auto rounded-t-[22px] bg-white p-4 pb-6">
        <button type="button" aria-label={t.close} onClick={onClose} className="float-right grid h-8 w-8 place-items-center rounded-full bg-[#F2F7FB] text-base">✕</button>

        {step === "choose" && (
          <>
            <h2 className="m-0 text-[17px] font-bold">{t.chooseWhat}</h2>
            <p className="text-[13px] text-[#617085]">{t.chooseHelp}</p>
            {opts.items.map((i) => (
              <label key={i.key} className={`mt-2.5 flex cursor-pointer items-center gap-2.5 rounded-xl border-[1.5px] p-3 text-sm ${!i.payable ? "cursor-default border-[#dbe5ee] bg-[#F2F7FB] opacity-60" : picked[i.key] ? "border-[#148F77] bg-[#F0FAF7]" : "border-[#dbe5ee]"}`}>
                <input type="checkbox" className="h-[18px] w-[18px] accent-[#148F77]" disabled={!i.payable} checked={!!picked[i.key] && i.payable}
                  onChange={(e) => setPicked({ ...picked, [i.key]: e.target.checked })} />
                <span className="flex-1">{i.label}<small className="block text-xs text-[#617085]">{i.upcoming ? t.nextAhead : !i.payable ? t.notBilled : i.hint}</small></span>
                <b>{money(i.amount)}</b>
              </label>
            ))}
            <button type="button" disabled={!total || !opts.rails.length} onClick={() => setStep("method")}
              className="mt-4 w-full rounded-xl bg-[#148F77] p-3.5 text-[15px] font-bold text-white disabled:opacity-50">{t.cont} · {money(total)} ETB</button>
          </>
        )}

        {step === "method" && (
          <>
            <h2 className="m-0 text-[17px] font-bold">{t.payAmount} {money(total)} ETB</h2>
            <p className="text-[13px] text-[#617085]">{t.whereFrom}</p>
            {opts.rails.map((r) => (
              <label key={r.id} className={`mt-2.5 flex cursor-pointer items-center gap-2.5 rounded-xl border-[1.5px] p-3 text-sm ${railId === r.id ? "border-[#148F77] bg-[#F0FAF7]" : "border-[#dbe5ee]"}`}>
                <input type="radio" name="rail" className="h-[18px] w-[18px] accent-[#148F77]" checked={railId === r.id} onChange={() => setRailId(r.id)} />
                <span className="flex-1">{r.label}</span>
              </label>
            ))}
            {rail && (
              <div className="mt-2.5 rounded-xl bg-[#F2F7FB] p-3 text-[13.5px]">
                <div>{t.sendTo} <b>{money(total)} ETB</b> {t.sendToSuffix}</div>
                <div className="mt-1"><b>{rail.account_number}</b>{rail.account_name ? ` · ${rail.account_name}` : ""}</div>
              </div>
            )}
            <p className="mt-3.5 text-[13px]">{t.afterPay}</p>
            <label htmlFor="txn" className="sr-only">{t.txn}</label>
            <input id="txn" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={t.txnHint} autoComplete="off" autoCapitalize="characters"
              className="mt-1.5 w-full rounded-xl border-[1.5px] border-[#dbe5ee] p-3 text-base outline-none focus:border-[#148F77]" />
            <p role="alert" className="mt-1.5 min-h-4 text-xs text-[#b4322f]">{err}</p>
            <button type="button" disabled={busy} onClick={() => void submit()} className="mt-1.5 w-full rounded-xl bg-[#148F77] p-3.5 text-[15px] font-bold text-white disabled:opacity-60">{busy ? t.wait : t.iPaid}</button>
            <button type="button" onClick={() => setStep("choose")} className="mt-2.5 w-full rounded-xl border-[1.5px] border-[#148F77] p-3 font-bold text-[#148F77]">{t.back}</button>
          </>
        )}

        {step === "status" && st && (
          <>
            <h2 className="m-0 text-[17px] font-bold">{money(st.amount)} ETB · {st.rail}</h2>
            <p className="text-xs text-[#617085]">{st.reference.toUpperCase()}</p>
            <ol className="my-3.5 flex">
              {steps.map((s) => (
                <li key={s.n} className="flex-1 text-center text-[11.5px]">
                  <i className={`mx-auto mb-1 grid h-7 w-7 place-items-center rounded-full font-bold not-italic ${LOOK[s.look]}`}>{s.look === "done" ? "✓" : s.look === "bad" ? "!" : s.n}</i>{s.label}
                </li>
              ))}
            </ol>
            {state === "paid" && (
              <div role="status" className="rounded-xl bg-[#EAF3DE] p-3 text-[13.5px]"><b>{t.msgPaid} ✓</b><br />{st.receipt_no ? `${t.receipt} RCP-${String(st.receipt_no).padStart(6, "0")} · ` : ""}{money(st.amount)} ETB. {t.msgPaidBody}</div>
            )}
            {(state === "checking" || state === "waiting") && <div role="status" className="rounded-xl bg-[#FFF3E0] p-3 text-[13.5px]">{t.msgChecking}</div>}
            {state === "rejected" && (
              <div role="alert" className="rounded-xl bg-[#FCEBEB] p-3 text-[13.5px]"><b>{t.msgRefused}</b><br />{t.msgRefusedBody}</div>
            )}
            {state === "rejected" ? (
              <>
                <button type="button" onClick={() => { setSt(null); setStep("method"); }} className="mt-3.5 w-full rounded-xl bg-[#148F77] p-3.5 text-[15px] font-bold text-white">{t.again}</button>
                {phone && <a href={`tel:${phone.replace(/\s/g, "")}`} className="mt-2.5 block w-full rounded-xl border-[1.5px] border-[#148F77] p-3 text-center font-bold text-[#148F77]">{t.callClinic}</a>}
              </>
            ) : (
              <button type="button" onClick={onClose} className="mt-3.5 w-full rounded-xl bg-[#148F77] p-3.5 text-[15px] font-bold text-white">{state === "paid" ? t.doneBtn : t.close}</button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
