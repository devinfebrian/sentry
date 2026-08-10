import type {
  ActivityEvent,
  AgentStage,
  CaseSummary,
  DecisionRecord,
  EvidenceRecord,
  Finding,
  ReportSection,
} from "../domain/types";

export const fixturePipeline: AgentStage[] = [
  {
    id: "financial-analysis",
    order: 1,
    name: "Financial analysis investigator",
    status: "running",
    completed: 18,
    total: 22,
    startedAt: "2026-08-05T08:34:00Z",
    inputCount: 24,
    outputCount: 18,
  },
  {
    id: "fraud-pattern",
    order: 2,
    name: "Fraud pattern investigator",
    status: "running",
    completed: 14,
    total: 22,
    startedAt: "2026-08-05T08:41:00Z",
    inputCount: 18,
    outputCount: 14,
  },
  {
    id: "evidence-review",
    order: 3,
    name: "Evidence review and decision",
    status: "review",
    completed: 8,
    total: 17,
    startedAt: "2026-08-05T09:10:00Z",
    inputCount: 17,
    outputCount: 8,
  },
  {
    id: "reporting",
    order: 4,
    name: "Reporting",
    status: "waiting",
    completed: 4,
    total: 19,
    inputCount: 8,
    outputCount: 4,
  },
];

export const fixtureCases: CaseSummary[] = [
  // "analysing", not "analysed": fixturePipeline — the pipeline every demo case shares —
  // shows both agents still "running" (18/22, 14/22) and Reporting waiting at 4/19. Per the
  // real view's own rules (pipeline.running > 0 => 'analysing'), that pipeline is a case
  // still in progress, and this is the one demo case whose other steps get real content, so
  // its stage badge has to agree with what its own summary panel renders underneath it.
  { id: "INV-0248", databaseId: "00000000-0000-4000-8000-000000000248", entity: "Northstar Ltd", owner: "Maya Chen", risk: "high", stageId: "analysing", status: "review", ageDays: 2, lastActivity: "12 min ago" },
  { id: "INV-0245", databaseId: "00000000-0000-4000-8000-000000000245", entity: "Orchid Supply", owner: "Rafael Cole", risk: "medium", stageId: "awaiting-analysis", status: "open", ageDays: 4, lastActivity: "38 min ago" },
  { id: "INV-0241", databaseId: "00000000-0000-4000-8000-000000000241", entity: "Delta Works", owner: "Jaya Singh", risk: "low", stageId: "analysed", status: "open", ageDays: 6, lastActivity: "1 hr ago" },
  { id: "INV-0239", databaseId: "00000000-0000-4000-8000-000000000239", entity: "Blue Harbor Group", owner: "Maya Chen", risk: "high", stageId: "fraud-review", status: "review", ageDays: 7, lastActivity: "2 hrs ago" },
  { id: "INV-0237", databaseId: "00000000-0000-4000-8000-000000000237", entity: "Pine & Ledger", owner: "Rafael Cole", risk: "medium", stageId: "analysed", status: "approved", ageDays: 9, lastActivity: "Yesterday" },
  { id: "INV-0232", databaseId: "00000000-0000-4000-8000-000000000232", entity: "Aster Mobility", owner: "Jaya Singh", risk: "low", stageId: "analysed", status: "closed", ageDays: 14, lastActivity: "3 days ago" },
];

export const fixtureEvidence: EvidenceRecord[] = [
  { id: "E-118", caseId: "INV-0248", source: "Q2 ledger / row 1842", claim: "Three payments share a beneficiary account outside approved vendor records.", agent: "Fraud pattern investigator", confidence: 0.94, state: "supports", timestamp: "05 Aug 2026, 09:12", relevance: "supporting" },
  { id: "E-119", caseId: "INV-0248", source: "Vendor master / Northstar", claim: "Beneficiary address differs from the registered vendor address.", agent: "Financial analysis investigator", confidence: 0.81, state: "reviewed", timestamp: "05 Aug 2026, 09:08", relevance: "supporting" },
  { id: "E-120", caseId: "INV-0248", source: "Bank export / 2026-05-17", claim: "Payment timing falls within approved settlement window.", agent: "Evidence review and decision", confidence: 0.63, state: "contradicts", timestamp: "05 Aug 2026, 09:18", relevance: "contradictory" },
  { id: "E-121", caseId: "INV-0248", source: "Contract archive / NS-44", claim: "Contract allows an alternate payment account with written notice.", agent: "Evidence review and decision", confidence: 0.52, state: "needs-source", timestamp: "05 Aug 2026, 09:20", relevance: "context" },
  { id: "E-105", caseId: "INV-0245", source: "AP ledger / row 772", claim: "Invoice value is 18% above trailing quarterly average.", agent: "Financial analysis investigator", confidence: 0.88, state: "supports", timestamp: "04 Aug 2026, 15:40", relevance: "supporting" },
  { id: "E-106", caseId: "INV-0245", source: "Purchase order / OR-81", claim: "Purchase order covers the full invoice value.", agent: "Evidence review and decision", confidence: 0.91, state: "reviewed", timestamp: "04 Aug 2026, 16:02", relevance: "contradictory" },
  { id: "E-099", caseId: "INV-0241", source: "General ledger / row 204", claim: "Transaction cadence matches expected seasonal pattern.", agent: "Financial analysis investigator", confidence: 0.96, state: "supports", timestamp: "03 Aug 2026, 10:12", relevance: "supporting" },
  { id: "E-090", caseId: "INV-0239", source: "Card export / card 4471", claim: "Weekend transactions cluster near a newly added merchant.", agent: "Fraud pattern investigator", confidence: 0.86, state: "unreviewed", timestamp: "02 Aug 2026, 13:40", relevance: "supporting" },
  { id: "E-091", caseId: "INV-0239", source: "Merchant profile", claim: "Merchant ownership is still missing from the source package.", agent: "Fraud pattern investigator", confidence: 0.77, state: "needs-source", timestamp: "02 Aug 2026, 13:42", relevance: "context" },
  { id: "E-074", caseId: "INV-0237", source: "Remittance advice / 044", claim: "Payment was approved by two authorized reviewers.", agent: "Evidence review and decision", confidence: 0.95, state: "reviewed", timestamp: "31 Jul 2026, 11:20", relevance: "supporting" },
  { id: "E-075", caseId: "INV-0237", source: "Vendor record / Pine", claim: "Vendor has been active for 5 years with no prior flags.", agent: "Fraud pattern investigator", confidence: 0.92, state: "reviewed", timestamp: "31 Jul 2026, 11:24", relevance: "context" },
  { id: "E-061", caseId: "INV-0232", source: "GL export / 2026-07", claim: "All sampled transactions reconcile to the source statement.", agent: "Financial analysis investigator", confidence: 0.98, state: "supports", timestamp: "28 Jul 2026, 08:40", relevance: "supporting" },
];

export const fixtureFindings: Finding[] = [
  { id: "F-18", caseId: "INV-0248", agent: "Fraud pattern investigator", summary: "Beneficiary mismatch warrants enhanced review before payment release.", confidence: 0.89, severity: null, evidenceIds: ["E-118", "E-119"], contradictoryEvidenceIds: ["E-120"] },
  { id: "F-19", caseId: "INV-0248", agent: "Financial analysis investigator", summary: "Payment timing is within policy, but beneficiary change is not documented.", confidence: 0.78, severity: null, evidenceIds: ["E-119"], contradictoryEvidenceIds: ["E-120", "E-121"] },
  { id: "F-12", caseId: "INV-0245", agent: "Financial analysis investigator", summary: "Variance is material but supported by an approved purchase order.", confidence: 0.84, severity: null, evidenceIds: ["E-105", "E-106"], contradictoryEvidenceIds: [] },
  { id: "F-09", caseId: "INV-0239", agent: "Fraud pattern investigator", summary: "Weekend merchant cluster needs source ownership evidence.", confidence: 0.74, severity: null, evidenceIds: ["E-090"], contradictoryEvidenceIds: ["E-091"] },
];

export const fixtureActivity: ActivityEvent[] = [
  { id: "ACT-41", caseId: "INV-0248", type: "agent-retry", actor: "Maya Chen", timestamp: "05 Aug 2026, 09:02", rationale: "Re-ran fraud pattern analysis after vendor file refresh." },
  { id: "ACT-39", caseId: "INV-0237", type: "approval", actor: "Rafael Cole", timestamp: "31 Jul 2026, 11:30", rationale: "Evidence supports normal settlement activity." },
];

export const fixtureDecision: DecisionRecord = {
  id: "DEC-0248",
  caseId: "INV-0248",
  recommendation: "request-evidence",
  rationale: "Confirm beneficiary change notice before final disposition.",
  unresolvedQuestions: ["Was alternate beneficiary notice received before settlement?"],
  history: fixtureActivity.filter((event) => event.caseId === "INV-0248"),
  isApproved: false,
};

export const fixtureReportSections: ReportSection[] = [
  { id: "executive-summary", title: "Executive summary", content: "Northstar Ltd requires enhanced review before payment release.", isEditable: true },
  { id: "scope", title: "Scope", content: "Reviewed Q2 ledger, vendor master, bank export, and contract archive.", isEditable: true },
  { id: "methods", title: "Methods", content: "Financial variance and beneficiary pattern analysis across submitted records.", isEditable: true },
  { id: "findings", title: "Findings", content: "Beneficiary mismatch is supported by two source records; settlement timing provides contradictory context.", isEditable: true },
  { id: "evidence", title: "Evidence", content: "E-118, E-119, E-120, and E-121.", isEditable: false },
  { id: "decision", title: "Decision", content: "Request alternate beneficiary notice before approving the transaction.", isEditable: true },
  { id: "limitations", title: "Limitations", content: "Contract archive does not yet contain a beneficiary change notice.", isEditable: true },
];
