import { Navigate } from "react-router-dom";

import { useAuth } from "@/app/auth-context";
import { PlanUpsell } from "@/components/PlanUpsell";

/**
 * Stands in front of a page the clinic's plan may not include.
 *
 * It gates at the route rather than inside the page for two reasons. The page's
 * own hooks would otherwise have to run before it could decide, firing queries
 * the server is about to refuse with 403; and an early return in the middle of a
 * component's hooks is the rules-of-hooks bug that only shows up once someone
 * adds the next useQuery.
 *
 * Who sees what: the owner gets the case for the feature, anyone else goes back
 * to the dashboard. Reception reaching this by typing a URL should not be handed
 * a price list it cannot act on.
 */
export function PlanGate({
  feature,
  manage = "clinic.manage",
  children,
}: {
  feature: string;
  manage?: string;
  children: React.ReactNode;
}) {
  const { flagOn, can } = useAuth();
  if (flagOn(feature)) return <>{children}</>;
  if (!can(manage)) return <Navigate to="/" replace />;
  return <PlanUpsell feature={feature} />;
}
