import { Link } from "react-router-dom";
import type { EvidenceRecord, Finding } from "../../domain/types";
import { StatusBadge } from "../ui/StatusBadge";

interface FindingPanelProps {
  finding: Finding;
  evidence: EvidenceRecord[];
}

export function FindingPanel({ finding, evidence }: FindingPanelProps) {
  const linkedEvidence = evidence.filter((record) => finding.evidenceIds.includes(record.id));
  const contradictoryEvidence = evidence.filter((record) => finding.contradictoryEvidenceIds.includes(record.id));
  return (
    <article className="finding-panel">
      <div className="finding-panel-top"><span className="numeric">{finding.id}</span>{finding.severity && <StatusBadge status={finding.severity} label={`${finding.severity[0].toUpperCase()}${finding.severity.slice(1)} severity`} tone={finding.severity === "high" ? "risk" : finding.severity === "low" ? "confirm" : "warning"} />}<StatusBadge status="confidence" label={`${Math.round(finding.confidence * 100)}% confidence`} tone="action" /></div>
      <h3>{finding.summary}</h3>
      <p className="finding-agent">{finding.agent}</p>
      <div className="finding-evidence-group"><span className="section-kicker">Supporting evidence</span>{linkedEvidence.length > 0 ? linkedEvidence.map((record) => <Link className="finding-evidence-link" to={`/evidence?record=${record.id}`} key={record.id}><span className="numeric">{record.id}</span><span>{record.source}</span><span aria-hidden="true">-&gt;</span></Link>) : <span className="finding-warning">Needs source</span>}</div>
      {contradictoryEvidence.length > 0 && <div className="finding-evidence-group"><span className="section-kicker">Contradictory context</span>{contradictoryEvidence.map((record) => <Link className="finding-evidence-link finding-evidence-contradictory" to={`/evidence?record=${record.id}`} key={record.id}><span className="numeric">{record.id}</span><span>{record.source}</span><span aria-hidden="true">-&gt;</span></Link>)}</div>}
    </article>
  );
}
