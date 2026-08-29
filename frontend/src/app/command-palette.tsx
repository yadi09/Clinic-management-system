import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { useAuth } from "@/app/auth-context";
import { navSections, visibleNav } from "@/app/nav";
import { useDebounce } from "@/hooks/useDebounce";
import { searchPatients } from "@/features/patients/api";

/** Global ⌘K command palette: jump to screens, register a patient, search patients. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const { can, flagOn } = useAuth();
  const debounced = useDebounce(query, 250);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("open-command", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command", onOpen);
    };
  }, []);

  const canSearch = can("patient.search") || can("patient.read");
  const { data: patients } = useQuery({
    queryKey: ["palette-patients", debounced],
    queryFn: () => searchPatients(debounced, 1, 6),
    enabled: open && canSearch && debounced.trim().length >= 2,
  });

  const go = (to: string) => {
    setOpen(false);
    setQuery("");
    navigate(to);
  };

  // Jumping to a page is still navigating: the palette offers exactly what the
  // sidebar offers, so it cannot route a general clinic into a dental report.
  const navItems = visibleNav(navSections, can, flagOn).flatMap((s) => s.items);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search patients, or jump to…" value={query} onValueChange={setQuery} />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        {patients && patients.items.length > 0 && (
          <CommandGroup heading="Patients">
            {patients.items.map((p) => (
              <CommandItem key={p.id} value={`patient-${p.id}`} onSelect={() => go(`/patients/${p.id}`)}>
                <span className="font-medium">
                  {[p.first_name, p.last_name].filter(Boolean).join(" ")}
                </span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{p.mrn}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {can("patient.create") && (
          <CommandGroup heading="Actions">
            <CommandItem value="register-patient" onSelect={() => go("/patients/new")}>
              <UserPlus /> Register patient
            </CommandItem>
          </CommandGroup>
        )}

        <CommandGroup heading="Go to">
          {navItems.map((item) => (
            <CommandItem key={item.to} value={`nav-${item.label}`} onSelect={() => go(item.to)}>
              <item.icon /> {item.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
