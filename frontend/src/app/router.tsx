import { Routes, Route } from "react-router-dom";
import { AuthLayout } from "@/app/layouts/AuthLayout";
import { AppShell } from "@/app/layouts/AppShell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { LoginPage } from "@/features/auth/pages/LoginPage";
import { MfaPage } from "@/features/auth/pages/MfaPage";
import { AcceptInvitePage } from "@/features/auth/pages/AcceptInvitePage";
import { UsersPage } from "@/features/admin/pages/UsersPage";
import { DashboardPage } from "@/features/dashboard/pages/DashboardPage";
import { PatientsListPage } from "@/features/patients/pages/PatientsListPage";
import { PatientRegisterPage } from "@/features/patients/pages/PatientRegisterPage";
import { PatientProfilePage } from "@/features/patients/pages/PatientProfilePage";
import { SettingsPage } from "@/features/admin/pages/SettingsPage";
import { NotFoundPage } from "@/features/misc/NotFoundPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/mfa" element={<MfaPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/patients" element={<PatientsListPage />} />
          <Route path="/patients/new" element={<PatientRegisterPage />} />
          <Route path="/patients/:id" element={<PatientProfilePage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
