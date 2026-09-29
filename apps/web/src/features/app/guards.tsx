import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErrorState } from "../../components/ErrorState";
import { useSession } from "../auth/session";

function PageLoading() {
  return <div className="page-loading" role="status" aria-live="polite"><span>Loading…</span></div>;
}

export function RequireAuth({ children, needsHousehold = true }: { children: ReactNode; needsHousehold?: boolean }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <PageLoading />;
  if (session.isError) return <div className="auth"><div className="auth__main"><ErrorState message={session.error.message} onRetry={() => void session.refetch()} /></div></div>;
  if (!session.data) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  if (needsHousehold && session.data.households.length === 0) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

/** Only same-app paths are honoured, so `from` can never become an open redirect. */
export function safeReturnPath(from: unknown, fallback = "/"): string {
  return typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : fallback;
}

export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <PageLoading />;
  if (session.data) return <Navigate to={safeReturnPath((location.state as { from?: unknown } | null)?.from)} replace />;
  return <>{children}</>;
}
