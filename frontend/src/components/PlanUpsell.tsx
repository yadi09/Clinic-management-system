import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { planUsage } from "@/features/admin/api";

/**
 * What the owner sees where a feature they are not paying for would have been.
 *
 * Staff never reach this — the nav drops the link for anyone without the
 * clinic.manage permission, because a receptionist cannot act on it. The person
 * who can is told three things and nothing else: what the feature does, that the
 * clinic is not on it, and which plan is. The plan names come from the server, so
 * this cannot drift away from what is actually being sold the way a hardcoded
 * "upgrade to Pro" would.
 */
export function PlanUpsell({ feature }: { feature: string }) {
  const plan = useQuery({ queryKey: ["plan-usage"], queryFn: planUsage });
  if (plan.isLoading) return <Skeleton className="h-40 w-full max-w-xl" />;
  const f = plan.data?.features?.find((x) => x.code === feature);
  const on = f?.on_plans ?? [];
  return (
    <Card className="max-w-xl space-y-3 p-6">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Lock className="h-4 w-4" />
        <span className="text-xs uppercase tracking-wide">Not on this plan</span>
      </div>
      <h2 className="text-lg font-semibold text-brand">{f?.name ?? "This feature"}</h2>
      {f?.detail && <p className="text-sm text-muted-foreground">{f.detail}</p>}
      <p className="text-sm">
        {plan.data?.plan_name ? (
          <>
            This clinic is on <span className="font-medium">{plan.data.plan_name}</span>.{" "}
          </>
        ) : null}
        {on.length > 0 ? (
          <>
            It comes with{" "}
            <span className="font-medium text-foreground">
              {on.length === 1 ? on[0] : `${on.slice(0, -1).join(", ")} and ${on[on.length - 1]}`}
            </span>
            .
          </>
        ) : (
          <>Ask us about adding it.</>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        Nothing you have already recorded is affected. Talk to us and it can be switched on for this
        clinic without changing plan.
      </p>
    </Card>
  );
}
