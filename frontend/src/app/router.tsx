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
import { PatientImportPage } from "@/features/patients/pages/PatientImportPage";
import { PatientProfilePage } from "@/features/patients/pages/PatientProfilePage";
import { PatientSchedulePage } from "@/features/patients/pages/PatientSchedulePage";
import { SettingsPage } from "@/features/admin/pages/SettingsPage";
import { AppointmentsPage } from "@/features/scheduling/pages/AppointmentsPage";
import { QueuePage } from "@/features/scheduling/pages/QueuePage";
import { ReceptionPage } from "@/features/scheduling/pages/ReceptionPage";
import { TriagePage } from "@/features/scheduling/pages/TriagePage";
import { WorklistPage } from "@/features/scheduling/pages/WorklistPage";
import { ChairsidePage } from "@/features/dental/ChairsidePage";
import { UnbilledPage } from "@/features/dental/pages/UnbilledPage";
import { EncounterWorkspacePage } from "@/features/clinical/pages/EncounterWorkspacePage";
import { DispenseQueuePage } from "@/features/pharmacy/pages/DispenseQueuePage";
import { DispensePage } from "@/features/pharmacy/pages/DispensePage";
import { BatchesPage } from "@/features/pharmacy/pages/BatchesPage";
import { DrugCatalogPage } from "@/features/pharmacy/pages/DrugCatalogPage";
import { OtcSalePage } from "@/features/pharmacy/pages/OtcSalePage";
import { PharmacyDashboardPage } from "@/features/pharmacy/pages/PharmacyDashboardPage";
import { CatalogAdminPage } from "@/features/pharmacy/pages/CatalogAdminPage";
import { PurchasingPage } from "@/features/pharmacy/pages/PurchasingPage";
import { StockControlPage } from "@/features/pharmacy/pages/StockControlPage";
import { ReportsPage } from "@/features/pharmacy/pages/ReportsPage";
import { LabWorklistPage } from "@/features/lab/pages/LabWorklistPage";
import { LabOrderItemPage } from "@/features/lab/pages/LabOrderItemPage";
import { LabCatalogPage } from "@/features/lab/pages/LabCatalogPage";
import { LabInboxPage } from "@/features/lab/pages/LabInboxPage";
import { HelpCenterPage } from "@/features/help/HelpCenterPage";
import { CashierPage } from "@/features/billing/pages/CashierPage";
import { ServiceCatalogPage } from "@/features/billing/pages/ServiceCatalogPage";
import { MessagesPage } from "@/features/messaging/pages/MessagesPage";
import { Dhis2ReportPage } from "@/features/reporting/pages/Dhis2ReportPage";
import { BedsBoardPage } from "@/features/inpatient/pages/BedsBoardPage";
import { BedConfigPage } from "@/features/inpatient/pages/BedConfigPage";
import { BedReportsPage } from "@/features/inpatient/pages/BedReportsPage";
import { PlanGate } from "@/components/PlanGate";
import { FinancePage } from "@/features/billing/pages/FinancePage";
import { NotFoundPage } from "@/features/misc/NotFoundPage";
import { PlatformLoginPage } from "@/features/platform/pages/PlatformLoginPage";
import { PlatformConsolePage } from "@/features/platform/pages/PlatformConsolePage";
import { CampaignPage } from "@/features/campaign/CampaignPage";

export function AppRoutes() {
  return (
    <Routes>
      {/* Platform (vendor super-admin) — standalone, its own auth, outside the tenant shell. */}
      {/* The campaign page: public by an unguessable code, outside every shell —
          a dental clinic opening this from Telegram has no account and no theme. */}
      <Route path="/c/:code" element={<CampaignPage />} />

      <Route path="/platform/login" element={<PlatformLoginPage />} />
      <Route path="/platform" element={<PlatformConsolePage />} />

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
          <Route path="/patients/import" element={<PatientImportPage />} />
          <Route path="/patients/:id" element={<PatientProfilePage />} />
          <Route path="/patients/:id/schedule" element={<PatientSchedulePage />} />
          <Route path="/appointments" element={<AppointmentsPage />} />
          <Route path="/reception" element={<ReceptionPage />} />
          <Route path="/cashier" element={<CashierPage />} />
          <Route path="/finance" element={<PlanGate feature="finance_advanced"><FinancePage /></PlanGate>} />
          <Route path="/billing/services" element={<ServiceCatalogPage />} />
          <Route path="/messages" element={<PlanGate feature="messaging"><MessagesPage /></PlanGate>} />
          <Route path="/triage" element={<TriagePage />} />
          <Route path="/queue" element={<QueuePage />} />
          <Route path="/worklist" element={<WorklistPage />} />
          <Route path="/chairside" element={<ChairsidePage />} />
          <Route path="/dental/unbilled" element={<UnbilledPage />} />
          <Route path="/encounter/:queueEntryId" element={<EncounterWorkspacePage />} />
          <Route path="/pharmacy/queue" element={<DispenseQueuePage />} />
          <Route path="/pharmacy/dispense/:rxId" element={<DispensePage />} />
          <Route path="/pharmacy/batches" element={<BatchesPage />} />
          <Route path="/pharmacy/catalog" element={<DrugCatalogPage />} />
          <Route path="/pharmacy/otc" element={<OtcSalePage />} />
          <Route path="/pharmacy/dashboard" element={<PharmacyDashboardPage />} />
          <Route path="/pharmacy/admin/catalog" element={<CatalogAdminPage />} />
          <Route path="/pharmacy/purchasing" element={<PurchasingPage />} />
          <Route path="/pharmacy/stock-control" element={<StockControlPage />} />
          <Route path="/pharmacy/reports" element={<ReportsPage />} />
          <Route path="/lab" element={<LabWorklistPage />} />
          <Route path="/lab/inbox" element={<LabInboxPage />} />
          <Route path="/lab/items/:itemId" element={<LabOrderItemPage />} />
          <Route path="/lab/catalog" element={<LabCatalogPage />} />
          <Route path="/help" element={<HelpCenterPage />} />
          <Route path="/reporting/dhis2" element={<PlanGate feature="dhis2"><Dhis2ReportPage /></PlanGate>} />
          <Route path="/inpatient/beds" element={<BedsBoardPage />} />
          <Route path="/inpatient/config" element={<BedConfigPage />} />
          <Route path="/inpatient/reports" element={<BedReportsPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
