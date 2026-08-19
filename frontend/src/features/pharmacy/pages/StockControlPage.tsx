import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { adjustCountItem, approveStockCount, createStockCount, getStockCount, listStockCounts, setCounted } from "@/features/pharmacy/api";

export function StockControlPage() {
  const qc = useQueryClient();
  const counts = useQuery({ queryKey: ["stock-counts"], queryFn: listStockCounts });
  const [selected, setSelected] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => createStockCount(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["stock-counts"] });
      setSelected(r.id);
    },
    onError: () => toast.error("Could not start a count"),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1>Stock control</h1>
          <p className="text-sm text-muted-foreground">Counts &amp; adjustments</p>
        </div>
        <Button loading={create.isPending} onClick={() => create.mutate()}>
          <Plus /> New count
        </Button>
      </div>

      {selected ? (
        <CountDetail id={selected} onBack={() => setSelected(null)} />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            {/* Phones: this table is wider than the screen — scroll it sideways instead of crushing the columns. */}
            <table className="w-full min-w-[560px] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="p-3 font-medium">Started</th>
                  <th className="font-medium">Status</th>
                  <th className="p-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {(counts.data ?? []).map((c) => (
                  <tr key={c.id} className="border-b">
                    <td className="p-3">{new Date(c.created_at).toLocaleString()}</td>
                    <td><Badge variant={c.status === "approved" ? "success" : "outline"}>{c.status}</Badge></td>
                    <td className="p-3 text-right">
                      <button className="text-xs text-primary hover:underline" onClick={() => setSelected(c.id)}>Open</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(counts.data?.length ?? 0) === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No counts yet — start one.</p>}
        </Card>
      )}
    </div>
  );
}

function CountDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const count = useQuery({ queryKey: ["stock-count", id], queryFn: () => getStockCount(id) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["stock-count", id] });

  const save = useMutation({ mutationFn: ({ itemId, counted }: { itemId: string; counted: number }) => setCounted(itemId, counted), onSuccess: refresh });
  const adjust = useMutation({ mutationFn: (itemId: string) => adjustCountItem(itemId), onSuccess: refresh, onError: () => toast.error("Could not adjust") });
  const approve = useMutation({ mutationFn: () => approveStockCount(id), onSuccess: () => { toast.success("Count approved"); refresh(); }, onError: () => toast.error("Could not approve") });

  const locked = count.data?.status === "approved";

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <button className="text-sm text-muted-foreground hover:text-foreground" onClick={onBack}>← All counts</button>
        {!locked && <Button size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>Approve count</Button>}
        {locked && <Badge variant="success">approved</Badge>}
      </div>
      <div className="overflow-x-auto">
        {/* Phones: this table is wider than the screen — scroll it sideways instead of crushing the columns. */}
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">Drug</th>
              <th className="font-medium">On hand</th>
              <th className="font-medium">Counted</th>
              <th className="font-medium">Variance</th>
              <th className="p-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {(count.data?.items ?? []).map((it) => (
              <tr key={it.id} className="border-b">
                <td className="p-2">{it.drug_name}</td>
                <td>{it.on_hand}</td>
                <td>
                  <Input
                    type="number"
                    className="w-20"
                    defaultValue={it.counted}
                    disabled={locked || it.adjusted}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== it.counted) save.mutate({ itemId: it.id, counted: v });
                    }}
                  />
                </td>
                <td>
                  <Badge variant="outline" className={it.variance === 0 ? "" : it.variance > 0 ? "border-emerald-300 text-emerald-700" : "border-rose-300 text-rose-700"}>
                    {it.variance > 0 ? `+${it.variance}` : it.variance}
                  </Badge>
                </td>
                <td className="p-2 text-right">
                  {!locked && !it.adjusted && it.variance !== 0 && (
                    <button className="text-xs text-primary hover:underline" onClick={() => adjust.mutate(it.id)}>Adjust</button>
                  )}
                  {it.adjusted && <span className="text-xs text-muted-foreground">adjusted</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
