import { useQuery } from "@tanstack/react-query";
import { meApi } from "@/features/auth/api";
import { queryKeys } from "@/lib/query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function DashboardPage() {
  const { data, isLoading, isError, error } = useQuery({ queryKey: queryKeys.me, queryFn: meApi });

  if (isLoading) {
    return <p className="text-muted-foreground">Loading your workspace…</p>;
  }
  if (isError || !data) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load your profile</AlertTitle>
        <AlertDescription>{error instanceof Error ? error.message : "Unknown error"}</AlertDescription>
      </Alert>
    );
  }

  const enabledFlags = Object.entries(data.flags)
    .filter(([, on]) => on)
    .map(([flag]) => flag);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {data.user.full_name}</h1>
        <p className="text-muted-foreground">{data.user.email}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Roles</CardTitle>
            <CardDescription>Your assigned roles</CardDescription>
          </CardHeader>
          <CardContent>
            {data.user.roles.length ? (
              <ul className="flex flex-wrap gap-2">
                {data.user.roles.map((r) => (
                  <li key={r} className="rounded-full bg-secondary px-3 py-1 text-xs text-secondary-foreground">
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No roles assigned</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Permissions</CardTitle>
            <CardDescription>{data.permissions.length} granted</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {data.permissions.slice(0, 6).join(", ")}
              {data.permissions.length > 6 ? "…" : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enabled modules</CardTitle>
            <CardDescription>Feature flags for this tenant</CardDescription>
          </CardHeader>
          <CardContent>
            {enabledFlags.length ? (
              <ul className="flex flex-wrap gap-2">
                {enabledFlags.map((f) => (
                  <li key={f} className="rounded-full bg-primary/10 px-3 py-1 text-xs text-primary">
                    {f}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Core modules only</p>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        Phase 0 foundation is live. Patient management arrives in Phase 1.
      </p>
    </div>
  );
}
