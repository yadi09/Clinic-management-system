import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useDebounce } from "@/hooks/useDebounce";
import { useAuth } from "@/app/auth-context";
import { searchPatients } from "@/features/patients/api";

const PAGE_SIZE = 20;

export function PatientsListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const debouncedQ = useDebounce(q, 300);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["patients", debouncedQ, page],
    queryFn: () => searchPatients(debouncedQ, page, PAGE_SIZE),
  });

  const total = data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Patients</h1>
          <p className="text-sm text-muted-foreground">{total} registered</p>
        </div>
        {can("patient.create") && <Button onClick={() => navigate("/patients/new")}>Register patient</Button>}
      </div>

      <Input
        placeholder="Search by name, MRN, phone, or national ID…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPage(1);
        }}
      />

      <Card>
        {isLoading ? (
          <p className="p-6 text-muted-foreground">Loading…</p>
        ) : isError ? (
          <p className="p-6 text-destructive">Failed to load patients.</p>
        ) : !data || data.items.length === 0 ? (
          <p className="p-6 text-muted-foreground">No patients found.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">MRN</th>
                <th className="p-3 font-medium">Name</th>
                <th className="p-3 font-medium">Gender</th>
                <th className="p-3 font-medium">DOB</th>
                <th className="p-3 font-medium">Phone</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer border-b last:border-0 hover:bg-accent"
                  onClick={() => navigate(`/patients/${p.id}`)}
                >
                  <td className="p-3 font-mono text-xs">{p.mrn}</td>
                  <td className="p-3">
                    <Link to={`/patients/${p.id}`} className="font-medium text-primary hover:underline">
                      {[p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ")}
                    </Link>
                  </td>
                  <td className="p-3 capitalize">{p.gender}</td>
                  <td className="p-3">{p.dob}</td>
                  <td className="p-3">{p.phone ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
