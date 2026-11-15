import { useState } from "react";

import { clinicLogoUrl, type ClinicCard } from "@/features/auth/api";

function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/[\s-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** Which clinic you are signing in to: its logo (or initials), name and code. */
export function ClinicBadge({ clinic, detail, onChange }: { clinic: ClinicCard; detail?: string; onChange?: () => void }) {
  const [logo, setLogo] = useState(clinic.has_logo);
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
      {logo ? (
        <img src={clinicLogoUrl(clinic.slug)} alt="" onError={() => setLogo(false)}
          className="h-10 w-10 shrink-0 rounded-md bg-white object-contain" />
      ) : (
        <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
          {initials(clinic.name)}
        </span>
      )}
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate font-semibold" data-testid="clinic-name">{clinic.name}</p>
        <p className="truncate text-xs text-muted-foreground">{detail ?? clinic.slug}</p>
      </div>
      {onChange && (
        <button type="button" onClick={onChange} aria-label={`Change clinic (now ${clinic.name})`}
          className="shrink-0 rounded px-2 py-1 text-sm font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Change
        </button>
      )}
    </div>
  );
}
