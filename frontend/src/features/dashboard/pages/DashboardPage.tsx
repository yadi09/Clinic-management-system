import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Users, UserPlus, Settings, ToggleRight, ShieldCheck } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/app/auth-context";
import { searchPatients } from "@/features/patients/api";

function MetricCard({
  label,
  value,
  hint,
  loading,
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  loading?: boolean;
  className?: string;
}) {
  return (
    // Tighter padding and a smaller figure below sm so two tiles share a 390px
    // row without the numbers colliding with the tile edges.
    <Card className={className}>
      <CardContent className="p-4 sm:p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="mt-2 h-8 w-20" />
        ) : (
          <p className="mt-1 text-2xl font-bold tabular-nums text-brand sm:text-3xl">{value}</p>
        )}
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { user, permissions, flags, can } = useAuth();
  const canSearch = can("patient.search") || can("patient.read");

  const patients = useQuery({
    queryKey: ["patients", "", 1, 1],
    queryFn: () => searchPatients("", 1, 1),
    enabled: canSearch,
  });

  const enabledModules = Object.values(flags).filter(Boolean).length;
  const firstName = user?.full_name?.split(" ")[0] ?? "there";
  const role = (user?.roles?.[0] ?? "—").replace(/_/g, " ");

  const actions = [
    { to: "/patients/new", label: "Register patient", icon: UserPlus, show: can("patient.create") },
    { to: "/patients", label: "Find a patient", icon: Users, show: canSearch },
    { to: "/users", label: "Manage staff", icon: ShieldCheck, show: can("user.read") },
    { to: "/settings", label: "Clinic settings", icon: Settings, show: can("clinic.manage") },
  ].filter((a) => a.show);

  return (
    // Slightly tighter section rhythm on phones so Quick actions lands inside
    // the first viewport at 390px instead of below the fold.
    <div className="space-y-6 md:space-y-8">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1>Good day, {firstName}</h1>
          {/* On phones the role tile below is hidden — a static label shouldn't be
              the loudest element on a small screen — so it demotes to this chip. */}
          <Badge variant="brand" className="capitalize sm:hidden">{role}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">Here's your clinic at a glance.</p>
      </div>

      {/* Two KPI tiles fit side by side at 390px; stacking them singly pushed
          everything useful below the fold. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {canSearch && (
          <MetricCard label="Patients registered" value={patients.data?.meta.total ?? 0} loading={patients.isLoading} />
        )}
        <MetricCard label="Enabled modules" value={enabledModules} hint="Lab, Pharmacy, Inventory…" />
        <MetricCard label="Permissions" value={permissions.length} hint="Granted to your roles" />
        <MetricCard className="max-sm:hidden" label="Your role" value={role} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Quick actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {actions.map((a) => (
                <Link
                  key={a.to}
                  to={a.to}
                  className="flex items-center gap-3 rounded-md border bg-background p-4 text-sm font-medium transition-colors hover:border-primary hover:bg-accent"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <a.icon className="h-5 w-5" />
                  </span>
                  {a.label}
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ToggleRight className="h-5 w-5 text-primary" /> Modules
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {Object.entries(flags).map(([flag, on]) => (
              <Badge key={flag} variant={on ? "success" : "outline"}>
                {flag.replace(/_/g, " ")}
              </Badge>
            ))}
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        Appointments, queue, and consultation dashboards arrive in the next phases.
      </p>
    </div>
  );
}
