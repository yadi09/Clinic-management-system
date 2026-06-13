import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Search, UserPlus, Users } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebounce } from "@/hooks/useDebounce";
import { useAuth } from "@/app/auth-context";
import { searchPatients } from "@/features/patients/api";

const PAGE_SIZE = 20;

function fullName(p: { first_name: string; middle_name?: string; last_name: string }) {
  return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");
}

export function PatientsListPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const debouncedQ = useDebounce(q, 300);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["patients", debouncedQ, page],
    queryFn: () => searchPatients(debouncedQ, page, PAGE_SIZE),
  });

  const total = data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1>Patients</h1>
          <p className="text-sm text-muted-foreground">
            {isLoading ? "Loading…" : `${total} registered`}
          </p>
        </div>
        {can("patient.create") && (
          <Button onClick={() => navigate("/patients/new")}>
            <UserPlus /> Register patient
          </Button>
        )}
      </div>

      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search by name, MRN, phone, or national ID…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-3 p-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="p-10 text-center">
            <p className="text-sm text-destructive">Couldn't load patients.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-brand">
              <Users className="h-6 w-6" />
            </span>
            <div>
              <p className="font-semibold">{debouncedQ ? "No matching patients" : "No patients yet"}</p>
              <p className="text-sm text-muted-foreground">
                {debouncedQ ? "Try a different search." : "Register your first patient to get started."}
              </p>
            </div>
            {can("patient.create") && !debouncedQ && (
              <Button onClick={() => navigate("/patients/new")}>
                <UserPlus /> Register patient
              </Button>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>MRN</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Gender</TableHead>
                <TableHead>Date of birth</TableHead>
                <TableHead>Phone</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/patients/${p.id}`)}>
                  <TableCell className="font-mono text-xs tabular-nums">{p.mrn}</TableCell>
                  <TableCell className="font-medium text-brand">{fullName(p)}</TableCell>
                  <TableCell className="capitalize">{p.gender}</TableCell>
                  <TableCell className="tabular-nums">{p.dob}</TableCell>
                  <TableCell>{p.phone ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {total > PAGE_SIZE && (
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
      )}
    </div>
  );
}
