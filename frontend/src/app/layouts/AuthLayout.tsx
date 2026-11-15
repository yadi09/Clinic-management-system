import { Outlet } from "react-router-dom";
import { Activity, Check } from "lucide-react";

function Wordmark({ className = "", disc }: { className?: string; disc: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className={`flex h-9 w-9 items-center justify-center rounded-full ${disc}`}>
        <Activity className="h-5 w-5" />
      </span>
      <span className="text-2xl font-bold tracking-tight">ClinicOS</span>
    </div>
  );
}

const PROMISES = [
  "Each clinic and each branch is walled off from every other",
  "Sign-in is protected against guessing",
  "Built for clinics in Ethiopia",
];

/** The frame around signing in, the second step and accepting an invitation.
 *  Desktop: the ClinicOS panel on the left, the form on the right. Phone: the form
 *  alone, top-aligned — vertical centring pushed the button under the keyboard. */
export function AuthLayout() {
  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="hidden flex-col justify-between bg-brand p-10 text-brand-foreground md:flex lg:p-14">
        <Wordmark disc="bg-white text-brand" />
        <div className="max-w-sm space-y-5">
          <p className="text-3xl font-bold leading-tight">Your clinic&apos;s records, private to your clinic.</p>
          <ul className="space-y-3 text-sm opacity-90">
            {PROMISES.map((p) => (
              <li key={p} className="flex gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs opacity-75">Need help signing in? Ask your clinic&apos;s owner or admin.</p>
      </aside>
      <main className="flex min-h-screen items-start justify-center px-4 pb-8 pt-10 md:items-center md:p-8">
        <div className="w-full max-w-md space-y-6">
          <Wordmark className="justify-center text-brand md:hidden" disc="bg-brand text-brand-foreground" />
          <Outlet />
        </div>
      </main>
    </div>
  );
}
