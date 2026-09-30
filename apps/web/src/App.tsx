import { Navigate, Route, Routes } from "react-router-dom";
import { ClipboardCheck, ReceiptIndianRupee } from "lucide-react";
import { ForgotPasswordPage } from "./features/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./features/auth/ResetPasswordPage";
import { SignInPage } from "./features/auth/SignInPage";
import { SignUpPage } from "./features/auth/SignUpPage";
import { VerifyEmailPage } from "./features/auth/VerifyEmailPage";
import { AppShell } from "./features/app/AppShell";
import { TodayPage } from "./features/app/attendance/TodayPage";
import { ComingSoonPage } from "./features/app/ComingSoonPage";
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
import { OnboardingPage } from "./features/app/OnboardingPage";

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
        <Route path="checklist" element={<ComingSoonPage title="Checklist" icon={<ClipboardCheck size={22} />} heading="No tasks yet" text="Daily, weekly and monthly checklists are coming soon." />} />
        <Route path="bills" element={<ComingSoonPage title="Bills" icon={<ReceiptIndianRupee size={22} />} heading="Keep track of your monthly bills here." text="Bills, due dates and reminders are coming soon." />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="more" element={<MorePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
