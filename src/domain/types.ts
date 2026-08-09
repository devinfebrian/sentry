export type AgentStatus =
  | "waiting"
  | "running"
  | "review"
  | "complete"
  | "blocked"
  | "failed";

export type RiskLevel = "low" | "medium" | "high" | "not-assessed";

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

export interface CaseSummary {
  id: string;
  databaseId: string;
  entity: string;
  owner: string;
  risk: RiskLevel;
  stageId: string;
  status: "open" | "review" | "approved" | "closed";
  ageDays: number;
  lastActivity: string;
  analysisStatus?: "not-started";
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
  evidenceIds: string[];
  contradictoryEvidenceIds: string[];
}

/** The nine values permitted by the sentinel_activity_events event_type CHECK. */
export type ActivityEventType =
  | "investigation-created"
  | "upload-created"
  | "parse-started"
  | "parse-completed"
  | "parse-failed"
  | "member-invited"
  | "member-activated"
  | "member-role-changed"
  | "member-invite-rejected";

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
}

export interface SentinelActivityService {
  list(options?: { investigationId?: string; limit?: number }): Promise<ActivityEntry[]>;
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
