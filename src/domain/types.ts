export type AgentStatus =
  | "waiting"
  | "running"
  | "review"
  | "complete"
  | "blocked"
  | "failed";

export type RiskLevel = "low" | "medium" | "high" | "not-assessed";

/** How much a finding matters. Null where no producer rated it. */
export type Severity = "low" | "medium" | "high";

/**
 * What a case needs next, derived from its agent runs.
 *
 * The design spec's `evidence-review` and `reporting` are deliberately absent: nothing
 * writes sentinel_evidence.state, so no case can enter or leave evidence review, and the
 * decision and report steps are fixture-backed. They return when something can move a case
 * through them.
 */
export type CaseStage =
  | "awaiting-import"
  | "analysing"
  | "analysis-failed"
  | "awaiting-analysis"
  | "fraud-review"
  | "analysed";

export type EvidenceState =
  | "unreviewed"
  | "reviewed"
  | "supports"
  | "contradicts"
  | "needs-source";

export interface AgentStage {
  id: string;
  order: 1 | 2 | 3 | 4;
  name: string;
  status: AgentStatus;
  completed: number;
  total: number;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  inputCount?: number;
  outputCount?: number;
}

export type CaseStatus = "open" | "review" | "approved" | "closed";

export type DecisionAction =
  | "recommend-approve"
  | "recommend-reject"
  | "approve"
  | "reject"
  | "request-evidence";

export interface SentinelDecisionService {
  record(investigationId: string, action: DecisionAction, rationale: string): Promise<{ status: CaseStatus }>;
}

export interface CaseSummary {
  id: string;
  databaseId: string;
  entity: string;
  /** The resolved display name, for reading. */
  owner: string;
  /** The identifier, for deciding whether the viewer is the owner. */
  ownerId: string | null;
  risk: RiskLevel;
  stageId: CaseStage;
  status: CaseStatus;
  ageDays: number;
  lastActivity: string;
}

export interface SentinelInvestigationService {
  list(): Promise<CaseSummary[]>;
  getById(id: string): Promise<CaseSummary | null>;
  create(input: { entity: string; ownerId: string }): Promise<CaseSummary>;
}

export type SentinelMemberRole = "analyst" | "manager";
export type SentinelMemberStatus = "active" | "pending";

export interface SentinelMember {
  userId: string;
  /** Manager-only: analysts have no column grant on invited_email. */
  email: string | null;
  /** Readable by every active member, which is what makes owner names possible. */
  displayName: string | null;
  role: SentinelMemberRole;
  status: SentinelMemberStatus;
  joinedAt: string;
  isSelf: boolean;
}

export interface SentinelMemberService {
  list(): Promise<SentinelMember[]>;
  invite(email: string): Promise<void>;
  activate(userId: string): Promise<void>;
  setRole(userId: string, role: SentinelMemberRole): Promise<void>;
  rejectInvitation(userId: string): Promise<void>;
  /** Renames the caller only; the RPC ignores any other member. */
  setDisplayName(displayName: string): Promise<void>;
}

export interface EvidenceRecord {
  id: string;
  caseId: string;
  source: string;
  claim: string;
  agent: string;
  confidence: number;
  state: EvidenceState;
  timestamp: string;
  relevance: "supporting" | "contradictory" | "context";
}

export interface Finding {
  id: string;
  caseId: string;
  agent: string;
  summary: string;
  confidence: number;
  severity: Severity | null;
  evidenceIds: string[];
  contradictoryEvidenceIds: string[];
}

/** The fifteen values permitted by the sentinel_activity_events event_type CHECK. */
export type ActivityEventType =
  | "investigation-created"
  | "upload-created"
  | "parse-started"
  | "parse-completed"
  | "parse-failed"
  | "member-invited"
  | "member-activated"
  | "member-role-changed"
  | "member-invite-rejected"
  | "analysis-completed"
  | "analysis-failed"
  | "case-recommended"
  | "case-approved"
  | "case-rejected"
  | "case-evidence-requested";

/**
 * A recorded workspace event. Deliberately distinct from `ActivityEvent` below, which is a
 * fixture-backed decision history for the Decision step and shares none of these types.
 */
export interface ActivityEntry {
  id: string;
  investigationId: string | null;
  actorId: string | null;
  type: ActivityEventType;
  /** jsonb, so the shape varies per event type — read it through safe accessors. */
  metadata: Record<string, unknown>;
  occurredAt: string;
  /**
   * The actor's own words, on the events that have an author. Null everywhere else — a
   * parse did not have a reason, it had a result.
   */
  rationale?: string | null;
}

/** Findings and their evidence for one investigation, read together. */
export interface SentinelAnalysisService {
  list(investigationId: string, limit?: number): Promise<{ findings: Finding[]; evidence: EvidenceRecord[] }>;
}

export interface SentinelActivityService {
  list(options?: { investigationId?: string; limit?: number }): Promise<ActivityEntry[]>;
}

/**
 * The statuses a run can actually be in.
 *
 * A narrower set than AgentStatus: `review` and `blocked` are states the design spec
 * describes but nothing in the system produces yet, and claiming them would be decoration.
 */
export type AgentRunStatus = "waiting" | "running" | "complete" | "failed";

/** One producer's run against one upload. */
export interface AgentRun {
  id: string;
  uploadId: string;
  agentKey: string;
  status: AgentRunStatus;
  failureReason?: string;
  inputCount: number;
  outputCount: number;
  startedAt?: string;
  completedAt?: string;
}

export interface SentinelAgentRunService {
  /** Runs for one investigation, or every run in the workspace when omitted. */
  list(investigationId?: string): Promise<AgentRun[]>;
  /** Re-runs one agent against one upload. Resolves when the run has finished. */
  run(uploadId: string, agentKey: string): Promise<void>;
}

/** Fixture-only: the decision history rendered on a case, not the workspace activity feed. */
export interface ActivityEvent {
  id: string;
  caseId: string;
  type: "approval" | "rejection" | "evidence-request" | "agent-retry";
  actor: string;
  timestamp: string;
  rationale: string;
}

export interface DecisionRecord {
  id: string;
  caseId: string;
  recommendation: "approve" | "reject" | "request-evidence";
  rationale: string;
  unresolvedQuestions: string[];
  approver?: string;
  decidedAt?: string;
  history: ActivityEvent[];
  isApproved: boolean;
}

export interface ReportSection {
  id:
    | "executive-summary"
    | "scope"
    | "methods"
    | "findings"
    | "evidence"
    | "decision"
    | "limitations";
  title: string;
  content: string;
  isEditable: boolean;
}

export interface ImportRow {
  entity: string;
  values: Record<string, string | number>;
  sourceRow: number;
}

export type UploadStatus =
  | "created"
  | "uploading"
  | "uploaded"
  | "processing"
  | "parsed"
  | "failed";

export interface SentinelUpload {
  id: string;
  investigationId: string;
  status: UploadStatus;
  rowCount: number;
  warnings: string[];
  errorMessage: string | null;
}

export type UploadParserStatus = Extract<UploadStatus, "processing" | "parsed" | "failed">;

export interface UploadParserResult {
  uploadId: string;
  status: UploadParserStatus;
  rowCount?: number;
  warnings?: string[];
  errorMessage?: string;
}

export interface SentinelUploadService {
  createUpload(input: { investigationId: string; file: File }): Promise<SentinelUpload>;
  startParsing(uploadId: string): Promise<UploadParserResult>;
  getStatus(uploadId: string): Promise<SentinelUpload>;
  retryParsing(uploadId: string): Promise<UploadParserResult>;
  /** Null when an investigation has no upload, which is legitimate. */
  getLatestForInvestigation(investigationId: string): Promise<SentinelUpload | null>;
  /**
   * Always bounded. A parse accepts up to MAX_ROWS (100k) rows, so an unbounded read would
   * pull an entire import into the browser to show a handful of them.
   */
  listRows(uploadId: string, limit?: number): Promise<ImportRow[]>;
}
