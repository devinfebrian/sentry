import { fixtureEvidence } from "../fixtures";
import { EvidenceLedger } from "../../components/evidence/EvidenceLedger";

export function EvidencePage() {
  return <div className="evidence-page"><header className="page-heading page-heading-simple"><div><span className="eyebrow">Workspace / source review</span><h1>Evidence</h1><p>Trace agent findings back to source records, reviewers, and decision relevance.</p></div></header><EvidenceLedger records={fixtureEvidence} /></div>;
}
