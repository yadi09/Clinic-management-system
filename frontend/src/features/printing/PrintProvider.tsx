// Keeps the print engine informed about this clinic and hosts the preview.
//
// Mounted once inside the signed-in app. It reads the clinic's printing settings,
// the clinic name and the branch the person is working in, and publishes them where
// the print buttons (plain function calls) can reach them.
import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/app/auth-context";
import { getClinic, listBranches } from "@/features/admin/api";
import { getPrintSettings } from "@/features/printing/api";
import { setPrintContext } from "@/features/printing/context";
import { PrintHost } from "@/features/printing/PrintHost";
import { resolveSettings } from "@/features/printing/settings";

export function PrintProvider({ children }: { children?: ReactNode }) {
  const { activeBranchId } = useAuth();
  const stored = useQuery({ queryKey: ["print-settings"], queryFn: getPrintSettings, staleTime: 300_000, retry: false });
  const clinic = useQuery({ queryKey: ["clinic"], queryFn: getClinic, retry: false });
  const branches = useQuery({ queryKey: ["branches"], queryFn: listBranches });

  const branch = (branches.data ?? []).find((b) => b.id === activeBranchId) ?? null;
  useEffect(() => {
    setPrintContext({
      settings: resolveSettings(stored.data?.settings),
      logo: stored.data?.logo ?? "",
      clinicName: clinic.data?.name ?? "",
      branch: branch ? { id: branch.id, name: branch.name, address: branch.address, phone: branch.phone } : null,
    });
  }, [stored.data, clinic.data, branch]);

  return <>{children}<PrintHost /></>;
}
