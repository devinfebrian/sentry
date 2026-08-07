import { useState } from "react";
import type { ActivityEvent, DecisionRecord as DecisionRecordData } from "../../domain/types";
import { Button } from "../ui/Button";
import { StatusBadge } from "../ui/StatusBadge";

interface DecisionRecordProps {
  decision: DecisionRecordData;
  onDecision?: (decision: DecisionRecordData, event: ActivityEvent) => void;
}

const recommendationLabels = { approve: "Approve", reject: "Reject", "request-evidence": "Request more evidence" } as const;

export function DecisionRecord({ decision: initialDecision, onDecision }: DecisionRecordProps) {
  const [decision, setDecision] = useState(initialDecision);
  const [pendingAction, setPendingAction] = useState<DecisionRecordData["recommendation"] | null>(null);
  const [rationale, setRationale] = useState("");
  const needsRationale = pendingAction !== null && pendingAction !== decision.recommendation;

  const selectAction = (action: DecisionRecordData["recommendation"]) => {
    if (action === decision.recommendation && action === "approve") {
      submitAction(action, decision.rationale);
      return;
    }
    setPendingAction(action);
    setRationale(action === decision.recommendation ? decision.rationale : "");
  };

  const submitAction = (action: DecisionRecordData["recommendation"], actionRationale: string) => {
    if (action !== decision.recommendation && !actionRationale.trim()) return;
    const eventType: ActivityEvent["type"] = action === "approve" ? "approval" : action === "reject" ? "rejection" : "evidence-request";
    const event: ActivityEvent = { id: `ACT-${Date.now()}`, caseId: decision.caseId, type: eventType, actor: "Maya Chen", timestamp: "05 Aug 2026, 09:32", rationale: actionRationale.trim() || decision.rationale };
    const nextDecision: DecisionRecordData = { ...decision, recommendation: action, rationale: event.rationale, isApproved: action === "approve", approver: action === "approve" ? "Maya Chen" : undefined, decidedAt: action === "approve" ? event.timestamp : undefined, history: [...decision.history, event] };
    setDecision(nextDecision);
    setPendingAction(null);
    setRationale("");
    onDecision?.(nextDecision, event);
  };

  return (
    <section className="decision-record" aria-labelledby="decision-record-title">
      <div className="decision-record-heading"><div><span className="section-kicker">Decision / accountable review</span><h2 id="decision-record-title">Decision record</h2></div><StatusBadge status={decision.isApproved ? "approved" : "pending"} label={decision.isApproved ? "Approved" : "Pending approval"} tone={decision.isApproved ? "confirm" : "action"} /></div>
      <div className="decision-recommendation"><span className="section-kicker">Current recommendation</span><strong>{recommendationLabels[decision.recommendation]}</strong><p>{decision.rationale}</p></div>
      {decision.unresolvedQuestions.length > 0 && <div className="unresolved-box"><span className="section-kicker">Unresolved questions</span><ul>{decision.unresolvedQuestions.map((question) => <li key={question}>{question}</li>)}</ul></div>}
      <div className="decision-actions"><Button variant="primary" onClick={() => selectAction("approve")}>Approve decision</Button><Button variant="secondary" onClick={() => selectAction("request-evidence")}>Request more evidence</Button><Button variant="destructive" onClick={() => selectAction("reject")}>Reject recommendation</Button></div>
      {pendingAction && <form className="decision-form" onSubmit={(event) => { event.preventDefault(); submitAction(pendingAction, rationale); }}><label htmlFor="decision-rationale">Rationale {needsRationale && <span>(required for recommendation change)</span>}</label><textarea id="decision-rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} required={needsRationale} placeholder="Record why this decision changes or what evidence is needed." /><div><Button variant="secondary" type="submit">Save decision</Button><Button variant="quiet" type="button" onClick={() => setPendingAction(null)}>Cancel</Button></div></form>}
      <div className="decision-history"><div className="section-header-lined"><div><span className="section-kicker">Audit trail</span><h3>Revision history</h3></div><span className="section-meta">Immutable events</span></div><ol>{decision.history.map((event) => <li key={event.id}><span className="numeric">{event.timestamp}</span><strong>{event.actor}</strong><span>{event.rationale}</span></li>)}</ol></div>
    </section>
  );
}
