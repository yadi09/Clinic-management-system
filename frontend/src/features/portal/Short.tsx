// A long list of teeth ("UR8, UR7, UR6 … LL8") is unreadable on a phone. Show the first few
// and a "…" the patient can press to see them all (and again to fold it back).
import { useState } from "react";

export function Short({ text, keep = 4, showAll, showLess }: { text: string; keep?: number; showAll: string; showLess: string }) {
  const [open, setOpen] = useState(false);
  const parts = text.split(/,\s*/).filter(Boolean);
  if (parts.length <= keep + 1) return <>{text}</>;
  return (
    <>
      {open ? parts.join(", ") : parts.slice(0, keep).join(", ")}{" "}
      <button type="button" aria-expanded={open} aria-label={open ? showLess : `${showAll} (${parts.length})`} title={open ? showLess : `${showAll} (${parts.length})`}
        onClick={() => setOpen((o) => !o)} className="rounded-md px-1.5 align-baseline font-bold text-[#1F4E79] hover:bg-[#E6F1FB]">{open ? "▲" : "…"}</button>
    </>
  );
}
