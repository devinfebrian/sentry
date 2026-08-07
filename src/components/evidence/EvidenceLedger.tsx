import { useMemo, useState } from "react";
import type { EvidenceRecord, EvidenceState } from "../../domain/types";
import { StatusBadge } from "../ui/StatusBadge";

interface EvidenceLedgerProps {
  records: EvidenceRecord[];
  caseId?: string;
}

const stateLabels: Record<EvidenceState, string> = {
  unreviewed: "Unreviewed",
  reviewed: "Reviewed",
  supports: "Supports",
  contradicts: "Contradicts",
  "needs-source": "Needs source",
};

function stateTone(state: EvidenceState) {
  if (state === "supports" || state === "reviewed") return "confirm" as const;
  if (state === "contradicts" || state === "needs-source") return "risk" as const;
  return "neutral" as const;
}

function relevanceLabel(value: EvidenceRecord["relevance"]) {
  return value === "supporting" ? "Supporting" : value === "contradictory" ? "Contradictory" : "Context";
}

export function EvidenceLedger({ records, caseId }: EvidenceLedgerProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<EvidenceRecord | null>(null);
  const scopedRecords = caseId ? records.filter((record) => record.caseId === caseId) : records;
  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return scopedRecords;
    return scopedRecords.filter((record) => `${record.source} ${record.claim} ${record.agent} ${record.state}`.toLowerCase().includes(normalized));
  }, [query, scopedRecords]);

  return (
    <section className="evidence-ledger" aria-labelledby="evidence-ledger-title">
      <div className="ledger-toolbar">
        <div><span className="section-kicker">Evidence / traceability</span><h2 id="evidence-ledger-title">Evidence ledger</h2></div>
        <label className="ledger-search"><span className="sr-only">Search evidence</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search source, claim, or agent" /></label>
      </div>
      <div className="table-scroll">
        <table className="data-table evidence-table">
          <thead><tr><th scope="col">Source</th><th scope="col">Claim / transaction</th><th scope="col">Agent</th><th scope="col">Confidence</th><th scope="col">Review state</th><th scope="col">Relevance</th></tr></thead>
          <tbody>
            {filteredRecords.map((record) => <tr key={record.id}>
              <th scope="row"><button className="source-button" type="button" onClick={() => setSelected(record)}><span className="numeric">{record.id}</span><strong>{record.source}</strong></button></th>
              <td className="claim-cell">{record.claim}</td>
              <td>{record.agent}</td>
              <td className="numeric">{Math.round(record.confidence * 100)}%</td>
              <td><StatusBadge status={record.state} label={stateLabels[record.state]} tone={stateTone(record.state)} /></td>
              <td>{relevanceLabel(record.relevance)}</td>
            </tr>)}
          </tbody>
        </table>
        {filteredRecords.length === 0 && <div className="table-empty">No evidence matches this search.</div>}
      </div>
      {selected && <div className="evidence-detail-backdrop" role="presentation" onMouseDown={() => setSelected(null)}>
        <aside className="evidence-detail" role="dialog" aria-modal="true" aria-labelledby="evidence-detail-title" onMouseDown={(event) => event.stopPropagation()}>
          <button className="drawer-close" type="button" onClick={() => setSelected(null)}>Close</button>
          <span className="section-kicker">Source record / {selected.id}</span>
          <h3 id="evidence-detail-title">{selected.source}</h3>
          <p className="evidence-detail-claim">{selected.claim}</p>
          <dl className="evidence-detail-list"><div><dt>Originating agent</dt><dd>{selected.agent}</dd></div><div><dt>Confidence</dt><dd className="numeric">{Math.round(selected.confidence * 100)}%</dd></div><div><dt>Review state</dt><dd>{stateLabels[selected.state]}</dd></div><div><dt>Captured</dt><dd>{selected.timestamp}</dd></div></dl>
        </aside>
      </div>}
    </section>
  );
}
