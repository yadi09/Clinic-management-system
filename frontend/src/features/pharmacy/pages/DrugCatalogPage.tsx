import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listDrugs } from "@/features/pharmacy/api";

export function DrugCatalogPage() {
  const drugs = useQuery({ queryKey: ["drugs"], queryFn: () => listDrugs() });
  const [cls, setCls] = useState("");
  const [controlled, setControlled] = useState("");

  const classes = useMemo(
    () => Array.from(new Set((drugs.data ?? []).map((d) => d.drug_class).filter(Boolean))) as string[],
    [drugs.data],
  );
  const rows = (drugs.data ?? []).filter(
    (d) => (!cls || d.drug_class === cls) && (!controlled || String(d.is_controlled) === controlled),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1>Drug catalog</h1>
        <p className="text-sm text-muted-foreground">Reference &amp; stock</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select className="rounded-md border bg-background px-3 py-1.5 text-sm" value={cls} onChange={(e) => setCls(e.target.value)}>
          <option value="">Class: all</option>
          {classes.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className="rounded-md border bg-background px-3 py-1.5 text-sm" value={controlled} onChange={(e) => setControlled(e.target.value)}>
          <option value="">Controlled: all</option>
          <option value="true">Controlled only</option>
          <option value="false">Non-controlled</option>
        </select>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          {/* Phones: this table is wider than the screen — scroll it sideways instead of crushing the columns. */}
          <table className="w-full min-w-[560px] text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Drug</th>
                <th className="font-medium">Form</th>
                <th className="font-medium">Class</th>
                <th className="font-medium">On hand</th>
                <th className="font-medium">Controlled</th>
                <th className="p-3 font-medium">Price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b">
                  <td className="p-3 font-medium">{d.name}</td>
                  <td>{d.form || "—"}</td>
                  <td>{d.drug_class || "—"}</td>
                  <td className={d.on_hand <= d.reorder_level ? "font-medium text-amber-700" : ""}>{d.on_hand}</td>
                  <td>{d.is_controlled ? <Badge variant="outline">Yes</Badge> : "No"}</td>
                  <td className="p-3 font-medium">{d.unit_price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No drugs.</p>}
      </Card>
    </div>
  );
}
