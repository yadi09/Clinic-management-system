import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { FileUp, Search, UserPlus, Users } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebounce } from "@/hooks/useDebounce";
import { useAuth } from "@/app/auth-context";
import { searchPatients } from "@/features/patients/api";
import { dentalOutstanding } from "@/features/dental/api";
import { formatEthiopian } from "@/lib/ethiopian";
import { ageLabel } from "@/lib/utils";

const PAGE_SIZE = 20;

function fullName(p: { first_name: string; middle_name?: string; last_name: string }) {
  return [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(" ");
}

export function PatientsListPage() {
  const navigate = useNavigate();
  const { can, flagOn } = useAuth();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const debouncedQ = useDebounce(q, 300);
  const [gender, setGender] = useState("all");
  const filters = { gender: gender === "all" ? undefined : gender };
  const filtered = !!filters.gender;

  // Dental clinics flag patients who owe for treatment received. One list call
  // powers a red "owes" badge on the matching rows.
  const dental = flagOn("dental");
  const outstanding = useQuery({ queryKey: ["dental-outstanding"], queryFn: dentalOutstanding, enabled: dental });
  const owes = new Map((outstanding.data ?? []).map((o) => [o.patient_id, o.balance]));
  const birr = (s: string) => `${Number(s || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} ETB`;

  const { data, isLoading, isError, refetch } = useQuery({
    // Page size is part of the key: other views (Dashboard, booking) query the same
    // patients with a smaller page size, and without it they'd collide in the cache.
    queryKey: ["patients", debouncedQ, page, PAGE_SIZE, filters.gender],
    queryFn: () => searchPatients(debouncedQ, page, PAGE_SIZE, filters),
  });

  const total = data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      {/* On a phone the first job is finding a patient, so search comes right after
          the title and the action buttons demote below it. display:contents lets the
          three blocks reorder as flex siblings below md while md+ keeps the exact
          two-row desktop layout. */}
      <div className="flex flex-col gap-6">
        <div className="max-md:contents md:flex md:flex-wrap md:items-center md:justify-between md:gap-3">
          <div className="max-md:order-1">
            <h1>Patients</h1>
            <p className="text-sm text-muted-foreground">
              {isLoading ? "Loading…" : debouncedQ || filtered ? `${total} matching` : `${total} registered`}
            </p>
          </div>
          {can("patient.create") && (
            <div className="flex items-center gap-2 max-md:order-3">
              {/* Register leads on phones; importing old registers is the rarer task. */}
              <Button variant="outline" className="max-md:order-last" onClick={() => navigate("/patients/import")}>
                <FileUp /> Import old records
              </Button>
              <Button onClick={() => navigate("/patients/new")}>
                <UserPlus /> Register patient
              </Button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 max-md:order-2">
          <div className="relative min-w-[16rem] flex-1 md:max-w-xl">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Name, MRN, or phone"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>

          <Select value={gender} onValueChange={(v) => { setGender(v); setPage(1); }}>
            <SelectTrigger className="w-[9.5rem]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All genders</SelectItem>
              <SelectItem value="male">Male</SelectItem>
              <SelectItem value="female">Female</SelectItem>
              <SelectItem value="other">Other</SelectItem>
              <SelectItem value="unknown">Unknown</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
              <p className="font-semibold">{debouncedQ || filtered ? "No matching patients" : "No patients yet"}</p>
              <p className="text-sm text-muted-foreground">
                {debouncedQ || filtered ? "Try a different search or clear the filters." : "Register your first patient to get started."}
              </p>
            </div>
            {can("patient.create") && !debouncedQ && !filtered && (
              <Button onClick={() => navigate("/patients/new")}>
                <UserPlus /> Register patient
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* At 390px the six-column table clips the DOB mid-glyph and pushes phone
                off-screen with no scroll affordance — below md each patient becomes a
                card that fits the width and the whole card is the tap target. */}
            <ul className="divide-y md:hidden">
              {data.items.map((p) => (
                <li
                  key={p.id}
                  // The whole card is the tap target, so it must be a keyboard target
                  // too: a real tab stop that Enter/Space follows like the link it is.
                  role="link"
                  tabIndex={0}
                  className="cursor-pointer space-y-1 p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent/60"
                  onClick={() => navigate(`/patients/${p.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/patients/${p.id}`);
                    }
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-brand">
                      <span className="break-words">{fullName(p)}</span>
                      {dental && owes.has(p.id) && (
                        <Badge variant="destructive" className="tabular-nums">Owes {birr(owes.get(p.id)!)}</Badge>
                      )}
                    </span>
                    <Badge variant="outline" className="shrink-0 font-mono tabular-nums">{p.mrn}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <span className="capitalize">{p.gender}</span>
                    {" · "}
                    <span className="font-medium tabular-nums text-foreground">{ageLabel(p.dob)}</span>
                    {p.dob && (
                      <>
                        {" · "}
                        <span className="tabular-nums">{p.dob}</span>{" "}
                        <span className="text-xs">{formatEthiopian(p.dob)} EC</span>
                      </>
                    )}
                  </p>
                  {p.phone ? (
                    <a
                      href={`tel:${p.phone}`}
                      className="touch-hit inline-block text-sm font-medium tabular-nums text-brand"
                      // Dial the patient instead of following the card into the profile.
                      onClick={(e) => e.stopPropagation()}
                    >
                      {p.phone}
                    </a>
                  ) : (
                    <p className="text-sm text-muted-foreground">—</p>
                  )}
                </li>
              ))}
            </ul>

            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>MRN</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Gender</TableHead>
                    <TableHead>Date of birth</TableHead>
                    <TableHead>Age</TableHead>
                    <TableHead>Phone</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((p) => (
                    <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/patients/${p.id}`)}>
                      <TableCell className="font-mono text-xs tabular-nums">{p.mrn}</TableCell>
                      <TableCell className="font-medium text-brand">
                        <span className="inline-flex items-center gap-2">
                          {fullName(p)}
                          {dental && owes.has(p.id) && <Badge variant="destructive">Owes {birr(owes.get(p.id)!)}</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="capitalize">{p.gender}</TableCell>
                      <TableCell className="tabular-nums">
                        <div>{p.dob}</div>
                        {p.dob && <div className="text-xs text-muted-foreground">{formatEthiopian(p.dob)} EC</div>}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-medium tabular-nums">{ageLabel(p.dob)}</TableCell>
                      <TableCell>{p.phone ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
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
