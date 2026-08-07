import { Route, Routes } from "react-router-dom";
import { CaseWorkspacePage } from "../pages/CaseWorkspacePage";
import { CasesPage } from "../pages/CasesPage";
import { OverviewPage } from "../pages/OverviewPage";
import { fixtureCases, fixtureDecision, fixtureEvidence, fixtureFindings, fixturePipeline } from "./fixtures";
import { EvidencePage } from "./pages/EvidencePage";
import { OperationsPage } from "./pages/OperationsPage";
import { ReportsPage } from "./pages/ReportsPage";

const workspaceDemo = {
  cases: fixtureCases,
  pipeline: fixturePipeline,
  evidence: fixtureEvidence,
  findings: fixtureFindings,
  decision: fixtureDecision,
};

export function DemoRoutes() {
  return (
    <Routes>
      <Route index element={<OverviewPage demoData={{ cases: fixtureCases, pipeline: fixturePipeline }} />} />
      <Route path="cases" element={<CasesPage demoData={{ cases: fixtureCases }} />} />
      <Route path="cases/:caseId/:step" element={<CaseWorkspacePage demoData={workspaceDemo} />} />
      <Route path="evidence" element={<EvidencePage />} />
      <Route path="reports" element={<ReportsPage />} />
      <Route path="operations" element={<OperationsPage />} />
    </Routes>
  );
}
