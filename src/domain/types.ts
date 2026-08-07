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
  email: string | null;
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
  listRows(uploadId: string): Promise<ImportRow[]>;
}
