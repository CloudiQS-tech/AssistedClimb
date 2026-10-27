import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import SiteGate from "@/components/SiteGate";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";
import StudentJoin from "@/pages/student-join";
import Climb from "@/pages/climb";
import TeacherLogin from "@/pages/teacher-login";
import TeacherDashboard from "@/pages/teacher-dashboard";
import TeacherSafeguardingAdmin from "@/pages/teacher-safeguarding-admin";
import TeacherSafeguardingReview from "@/pages/teacher-safeguarding-review";
import TeacherArchive from "@/pages/teacher-archive";
import TeacherClass from "@/pages/teacher-class";
import TeacherStudentDetail from "@/pages/teacher-student-detail";
import TeacherStudentActivity from "@/pages/teacher-student-activity";
import TeacherStudentReport from "@/pages/teacher-student-report";
import DevAutoLogin from "@/pages/dev-autologin";
import TeacherSettings from "@/pages/teacher-settings";
import TeacherClassInsights from "@/pages/teacher-class-insights";
import TeacherClassActivity from "@/pages/teacher-class-activity";
import PlatformAdmin from "@/pages/platform-admin";
import TeacherChangePassword from "@/pages/teacher-change-password";
import ResetPassword from "@/pages/reset-password";
import ForgotPassword from "@/pages/forgot-password";
import TeacherVerifyEmail from "@/pages/teacher-verify-email";
import SessionTimeout from "@/components/SessionTimeout";

import TeacherAssignments from "@/pages/teacher-assignments";
import TeacherApprovals from "@/pages/teacher-approvals";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/join" component={StudentJoin} />
      <Route path="/climb" component={Climb} />
      <Route path="/teacher/login" component={TeacherLogin} />
      <Route path="/teacher/verify-email" component={TeacherVerifyEmail} />
      <Route path="/teacher" component={TeacherDashboard} />
      <Route path="/teacher/dashboard" component={TeacherDashboard} />
      <Route path="/teacher/assignments" component={TeacherAssignments} />
      <Route path="/teacher/approvals" component={TeacherApprovals} />
      <Route path="/teacher/archive" component={TeacherArchive} />
      <Route path="/teacher/class/:classId/insights" component={TeacherClassInsights} />
      <Route path="/teacher/class/:classId/activity" component={TeacherClassActivity} />
      <Route path="/teacher/class/:classId/student/:sessionId/report" component={TeacherStudentReport} />
      <Route path="/teacher/class/:classId/student/:sessionId/activity" component={TeacherStudentActivity} />
      <Route path="/teacher/class/:classId/student/:sessionId" component={TeacherStudentDetail} />
      <Route path="/teacher/class/:classId" component={TeacherClass} />
      {import.meta.env.DEV && <Route path="/dev-autologin" component={DevAutoLogin} />}
      <Route path="/teacher/settings" component={TeacherSettings} />
      <Route path="/teacher/safeguarding-admin" component={TeacherSafeguardingAdmin} />
      <Route path="/teacher/safeguarding" component={TeacherSafeguardingReview} />
      <Route path="/teacher/change-password" component={TeacherChangePassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/admin" component={PlatformAdmin} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SiteGate>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
            <SessionTimeout />
          </WouterRouter>
          <Toaster />
        </SiteGate>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
