import { Card } from "@/components/ui/card";
import { useAuth } from "@/app/auth-context";
import { navSections, visibleNav } from "@/app/nav";
import { GLOSSARY, helpForRoute, type HelpEntry } from "@/features/help/content";

// HelpCenterPage shows help for the pages THIS role can reach (built from the same
// nav + help data), plus a shared glossary.
export function HelpCenterPage() {
  const { can, user, flagOn } = useAuth();
  const role = user?.roles?.[0]?.replace(/_/g, " ") ?? "your role";

  // Help for a module the clinic doesn't have is worse than no help: it teaches
  // a workflow the staff cannot follow. Same filter as the sidebar.
  const sections = visibleNav(navSections, can, flagOn)
    .map((s) => ({
      heading: s.heading,
      items: s.items
        .map((i) => ({ label: i.label, entry: helpForRoute(i.to) }))
        .filter((x): x is { label: string; entry: HelpEntry } => !!x.entry),
    }))
    .filter((s) => s.items.length > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1>Help Center</h1>
        <p className="text-sm text-muted-foreground">
          A guide to the pages you use as <span className="font-medium capitalize">{role}</span>. Every page also has a
          “How this works” button in the top bar.
        </p>
      </div>

      {sections.map((s) => (
        <section key={s.heading ?? "general"} className="space-y-3">
          {s.heading && <h2 className="text-h3">{s.heading}</h2>}
          {s.items.map(({ label, entry }) => (
            <Card key={label} className="space-y-3 p-5">
              <div>
                <h3 className="font-semibold text-brand">{entry.title}</h3>
                <p className="text-sm text-muted-foreground">{entry.purpose}</p>
              </div>

              {entry.sections?.length ? (
                <div className="space-y-2">
                  {entry.sections.map((sec) => (
                    <div key={sec.h} className="text-sm">
                      <span className="font-medium">{sec.h}: </span>
                      <span className="text-muted-foreground">{sec.body}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {entry.columns?.length ? (
                <dl className="divide-y rounded-md border text-sm">
                  {entry.columns.map((c) => (
                    <div key={c.name} className="flex gap-3 px-3 py-1.5">
                      <dt className="w-28 shrink-0 font-medium">{c.name}</dt>
                      <dd className="text-muted-foreground">{c.desc}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {entry.tips?.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {entry.tips.map((t) => <li key={t}>{t}</li>)}
                </ul>
              ) : null}
            </Card>
          ))}
        </section>
      ))}

      <section className="space-y-3">
        <h2 className="text-h3">Glossary</h2>
        <Card className="divide-y p-0">
          {GLOSSARY.map((g) => (
            <div key={g.term} className="flex gap-3 px-5 py-2.5 text-sm">
              <span className="w-40 shrink-0 font-medium">{g.term}</span>
              <span className="text-muted-foreground">{g.def}</span>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
