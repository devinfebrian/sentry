import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { ToastProvider, useToast } from "../components/ui/ToastRegion";
import { OverviewPage } from "../pages/OverviewPage";
import { CasesPage } from "../pages/CasesPage";
import { CaseWorkspacePage } from "../pages/CaseWorkspacePage";
import { AnalysisNotStartedPage } from "../pages/AnalysisNotStartedPage";
import { WorkspacePage } from "../pages/WorkspacePage";
import { ImportDialog } from "../components/import/ImportDialog";
import { ErrorState } from "../components/ui/ErrorState";
import type { ImportPreview } from "../services/importParser";
import { createImportWorkflow, type ImportOutcome } from "../services/importWorkflow";
import { ProtectedRoute } from "../auth/ProtectedRoute";
import { SignInPage } from "../pages/SignInPage";
import { useAuth } from "../auth/AuthProvider";
import { createSentinelInvestigationService } from "../services/sentinelInvestigations";
import type { SentinelInvestigationClient } from "../services/sentinelInvestigations";
import { createSentinelUploadService } from "../services/sentinelUploads";
import type { SentinelUploadClient } from "../services/sentinelUploads";
import { createSentinelMemberService } from "../services/sentinelMembers";
import type { SentinelMemberClient } from "../services/sentinelMembers";
import { supabase } from "../lib/supabase";

const DemoRoutePage = import.meta.env.DEV
  ? lazy(() => import("../demo/DemoRoutes").then(({ DemoRoutes }) => ({ default: DemoRoutes })))
  : null;

function NotFoundPage() {
  return <ErrorState title="Page not found" description="This workspace route does not exist. Return to Overview to continue your investigation." action={<a className="text-link" href="/">Return to Overview -&gt;</a>} />;
}

function WorkspaceLayout() {
  const [importOpen, setImportOpen] = useState(false);
  const overviewImportButtonRef = useRef<HTMLButtonElement>(null);
  const casesImportButtonRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const { user, workspaceId, role } = useAuth();
  const serviceContext = user?.id && workspaceId ? { workspaceId, userId: user.id } : null;
  const investigationClient = supabase ? supabase as unknown as SentinelInvestigationClient : null;
  const uploadClient = supabase ? supabase as unknown as SentinelUploadClient : null;
  const memberClient = supabase ? supabase as unknown as SentinelMemberClient : null;
  const investigationService = useMemo(() => investigationClient && serviceContext
    ? createSentinelInvestigationService(investigationClient, serviceContext)
    : null, [investigationClient, user?.id, workspaceId]);
  const uploadService = useMemo(() => uploadClient && serviceContext
    ? createSentinelUploadService(uploadClient, serviceContext)
    : null, [uploadClient, user?.id, workspaceId]);
  // Role decides which source list() reads, so it belongs in the service context.
  const memberService = useMemo(() => memberClient && serviceContext
    ? createSentinelMemberService(memberClient, { ...serviceContext, role })
    : null, [memberClient, user?.id, workspaceId, role]);

  const importWorkflow = useMemo(() => investigationService && uploadService && user?.id
    ? createImportWorkflow({ investigations: investigationService, uploads: uploadService, ownerId: user.id })
    : null, [investigationService, uploadService, user?.id]);

  // The workflow reports what happened; routing and toasts stay here, at the edge. A retry
  // is announced the same way, so a recovered import lands on its case like a clean one.
  const announce = (outcome: ImportOutcome): ImportOutcome => {
    if (outcome.status === "failed") {
      return { ...outcome, retry: async () => announce(await outcome.retry()) };
    }

    navigate(`/cases/${outcome.investigationId}/summary`);
    pushToast(`Investigation ${outcome.investigationId} created. Upload ${outcome.status === "parsed" ? "parsed" : "processing started"}.`);
    return outcome;
  };

  const handleImported = async (file: File, preview: ImportPreview): Promise<ImportOutcome> => {
    if (!importWorkflow || !workspaceId) {
      throw new Error("Unable to import data: active workspace connection is unavailable. Sign in again and retry.");
    }
    return announce(await importWorkflow.run({ file, preview }));
  };

  const activeImportButtonRef = location.pathname === "/cases" ? casesImportButtonRef : overviewImportButtonRef;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<OverviewPage investigationService={investigationService} importButtonRef={overviewImportButtonRef} onImportData={() => setImportOpen(true)} />} />
        <Route path="/cases" element={<CasesPage investigationService={investigationService} importButtonRef={casesImportButtonRef} onImportData={() => setImportOpen(true)} />} />
        <Route path="/cases/:caseId/:step" element={<CaseWorkspacePage investigationService={investigationService} uploadService={uploadService} />} />
        <Route path="/evidence" element={<AnalysisNotStartedPage module="Evidence" step="evidence" />} />
        <Route path="/reports" element={<AnalysisNotStartedPage module="Reports" step="report" />} />
        <Route path="/operations" element={<AnalysisNotStartedPage module="Agent pipeline" step="summary" />} />
        {DemoRoutePage && <Route path="/demo/*" element={<Suspense fallback={<div role="status">Loading demo</div>}><DemoRoutePage /></Suspense>} />}
        <Route path="/workspace" element={<WorkspacePage memberService={memberService} role={role} />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={handleImported} returnFocusRef={activeImportButtonRef} />
    </AppShell>
  );
}

function RoutedApp() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInPage />} />
      <Route path="*" element={<ProtectedRoute><WorkspaceLayout /></ProtectedRoute>} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <RoutedApp />
      </ToastProvider>
    </BrowserRouter>
  );
}
