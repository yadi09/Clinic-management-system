// For a paper whose QR will not scan: the clinic's name and the short code printed
// under the QR. Opens the same page the QR would have.
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ScanLine } from "lucide-react";

// "Cure Dental" typed from memory still finds cure-dental.
const clean = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function VerifyEntryPage() {
  const navigate = useNavigate();
  const [clinic, setClinic] = useState("");
  const [code, setCode] = useState("");
  const [tried, setTried] = useState(false);

  const slug = clean(clinic);
  const c = cleanCode(code);
  const ok = slug.length > 0 && c.length === 8;

  const go = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (ok) navigate(`/v/${slug}/${c}`);
  };

  return (
    <div className="min-h-dvh bg-slate-100 text-slate-900">
      <main className="mx-auto w-full max-w-md px-4 pb-12 pt-10">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-800 text-white" aria-hidden>
          <ScanLine className="h-7 w-7" />
        </span>
        <h1 className="mt-4 text-2xl font-bold leading-tight text-slate-900">Check a printed paper</h1>
        <p className="mt-1 text-base text-slate-600">
          Scan the QR on the paper with your phone camera. If it will not scan, type what is printed under it.
        </p>

        <form onSubmit={go} noValidate className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <label className="block">
            <span className="text-sm font-medium">Clinic</span>
            <input value={clinic} onChange={(e) => setClinic(e.target.value)} inputMode="text" autoCapitalize="none"
              autoCorrect="off" spellCheck={false} placeholder="cure-dental"
              className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-3 text-lg outline-none focus:border-slate-800 focus:ring-2 focus:ring-slate-300" />
            <span className="mt-1 block text-xs text-slate-500">The name just before the code, for example <b>cure-dental</b>.</span>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Code</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoCorrect="off"
              spellCheck={false} placeholder="K7MQ-4XPR" maxLength={12}
              className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-3 font-mono text-lg tracking-widest outline-none focus:border-slate-800 focus:ring-2 focus:ring-slate-300" />
            <span className="mt-1 block text-xs text-slate-500">Eight letters and numbers, in two groups of four.</span>
          </label>
          {tried && !ok && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">
              Enter the clinic's name and the eight-character code printed under the QR.
            </p>
          )}
          <button type="submit"
            className="w-full rounded-xl bg-slate-900 px-4 py-3 text-base font-semibold text-white focus:outline-none focus:ring-2 focus:ring-slate-400">
            Check this paper
          </button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-500">ClinicOS</p>
      </main>
    </div>
  );
}
