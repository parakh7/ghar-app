import { Navigate, Route, Routes } from "react-router-dom";
import { ForgotPasswordPage } from "./features/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./features/auth/ResetPasswordPage";
import { SignInPage } from "./features/auth/SignInPage";
import { SignUpPage } from "./features/auth/SignUpPage";
import { VerifyEmailPage } from "./features/auth/VerifyEmailPage";
import { AppShell } from "./features/app/AppShell";
import { HousehelpCalendarPage } from "./features/app/attendance/HousehelpCalendarPage";
import { TodayPage } from "./features/app/attendance/TodayPage";
import { BillCategoriesPage } from "./features/app/bills/BillCategoriesPage";
import { BillDetailPage } from "./features/app/bills/BillDetailPage";
import { BillFormPage } from "./features/app/bills/BillFormPage";
import { BillsListPage } from "./features/app/bills/BillsListPage";
import { ChecklistListPage } from "./features/app/checklist/ChecklistListPage";
import { ChecklistTaskDetailPage } from "./features/app/checklist/ChecklistTaskDetailPage";
import { ChecklistTaskFormPage } from "./features/app/checklist/ChecklistTaskFormPage";
import { ChecklistTodayPage } from "./features/app/checklist/ChecklistTodayPage";
import { RedirectIfSignedIn, RequireAuth } from "./features/app/guards";
import { HomePage } from "./features/app/HomePage";
import { CategoriesPage } from "./features/app/househelps/CategoriesPage";
import { HousehelpDetailPage } from "./features/app/househelps/HousehelpDetailPage";
import { HousehelpFormPage } from "./features/app/househelps/HousehelpFormPage";
import { HousehelpsListPage } from "./features/app/househelps/HousehelpsListPage";
import { ScheduleEditorPage } from "./features/app/househelps/ScheduleEditorPage";
import { AcceptInvitePage } from "./features/app/members/AcceptInvitePage";
import { MembersPage } from "./features/app/members/MembersPage";
import { MorePage } from "./features/app/MorePage";
import { NotificationsPage } from "./features/notifications/NotificationsPage";
import { NotificationSettingsPage } from "./features/settings/NotificationSettingsPage";
import { OnboardingPage } from "./features/app/OnboardingPage";
import { SearchPage } from "./features/search/SearchPage";
import { SalaryListPage } from "./features/app/salary/SalaryListPage";
import { SettlementDetailPage } from "./features/app/salary/SettlementDetailPage";

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<RedirectIfSignedIn><SignInPage /></RedirectIfSignedIn>} />
      <Route path="/signup" element={<RedirectIfSignedIn><SignUpPage /></RedirectIfSignedIn>} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/onboarding" element={<RequireAuth needsHousehold={false}><OnboardingPage /></RequireAuth>} />
      <Route path="/onboarding/new" element={<RequireAuth needsHousehold={false}><OnboardingPage /></RequireAuth>} />
      <Route path="/invites/accept" element={<RequireAuth needsHousehold={false}><AcceptInvitePage /></RequireAuth>} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<HomePage />} />
        <Route path="househelps" element={<HousehelpsListPage />} />
        <Route path="attendance" element={<TodayPage />} />
        <Route path="househelps/categories" element={<CategoriesPage />} />
        <Route path="househelps/new" element={<HousehelpFormPage mode="create" />} />
        <Route path="househelps/:id" element={<HousehelpDetailPage />} />
        <Route path="househelps/:id/edit" element={<HousehelpFormPage mode="edit" />} />
        <Route path="househelps/:id/schedule" element={<ScheduleEditorPage />} />
        <Route path="househelps/:id/attendance" element={<HousehelpCalendarPage />} />
        <Route path="checklist" element={<ChecklistListPage />} />
        <Route path="checklist/today" element={<ChecklistTodayPage />} />
        <Route path="checklist/new" element={<ChecklistTaskFormPage mode="create" />} />
        <Route path="checklist/:id" element={<ChecklistTaskDetailPage />} />
        <Route path="checklist/:id/edit" element={<ChecklistTaskFormPage mode="edit" />} />
        <Route path="salary" element={<SalaryListPage />} />
        <Route path="salary/:id" element={<SettlementDetailPage />} />
        <Route path="bills" element={<BillsListPage />} />
        <Route path="bills/categories" element={<BillCategoriesPage />} />
        <Route path="bills/new" element={<BillFormPage mode="create" />} />
        <Route path="bills/:id" element={<BillDetailPage />} />
        <Route path="bills/:id/edit" element={<BillFormPage mode="edit" />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings/notifications" element={<NotificationSettingsPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="more" element={<MorePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
