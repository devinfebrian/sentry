import { fixtureReportSections } from "../fixtures";
import { ReportComposer } from "../../components/reports/ReportComposer";
import { useToast } from "../../components/ui/ToastRegion";

export function ReportsPage() {
  const { pushToast } = useToast();
  return <div className="reports-page"><header className="page-heading page-heading-simple"><div><span className="eyebrow">Workspace / reviewed output</span><h1>Reports</h1><p>Assemble audit-ready reports from reviewed evidence and accountable decisions.</p></div></header><ReportComposer sections={fixtureReportSections} onExport={() => { document.title = "Northstar Ltd - Investigation report"; window.print(); pushToast("PDF export started from browser print dialog."); }} /></div>;
}
