import { Navigate, Route, Routes } from "react-router-dom";
import { ClipboardCheck, ReceiptIndianRupee, Users } from "lucide-react";
import { ForgotPasswordPage } from "./features/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "./features/auth/ResetPasswordPage";
import { SignInPage } from "./features/auth/SignInPage";
import { SignUpPage } from "./features/auth/SignUpPage";
import { VerifyEmailPage } from "./features/auth/VerifyEmailPage";
import { AppShell } from "./features/app/AppShell";
import { ComingSoonPage } from "./features/app/ComingSoonPage";
import { RedirectIfSignedIn, RequireAuth } from "./features/app/guards";
import { HomePage } from "./features/app/HomePage";
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
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route index element={<HomePage />} />
        <Route path="househelps" element={<ComingSoonPage title="Househelps" icon={<Users size={22} />} heading="Your household doesn't have any househelps yet." text="Adding househelps, schedules and salaries is coming in the next update." />} />
        <Route path="checklist" element={<ComingSoonPage title="Checklist" icon={<ClipboardCheck size={22} />} heading="No tasks yet" text="Daily, weekly and monthly checklists are coming soon." />} />
        <Route path="bills" element={<ComingSoonPage title="Bills" icon={<ReceiptIndianRupee size={22} />} heading="Keep track of your monthly bills here." text="Bills, due dates and reminders are coming soon." />} />
        <Route path="members" element={<MembersPage />} />
        <Route path="more" element={<MorePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
