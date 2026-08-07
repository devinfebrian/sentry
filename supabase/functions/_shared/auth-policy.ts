export interface MembershipLike {
  status?: unknown;
  role?: unknown;
}

export interface InviteRequest {
  email: string;
  role: "analyst";
}

export interface UploadRequest {
  uploadId: string;
}

export class PolicyError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PolicyError";
    this.status = status;
  }
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const email = value.trim().toLowerCase();
  return email.length <= 254 && emailPattern.test(email) ? email : null;
}

export function getBearerToken(value: string | null) {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || null;
}

export function isActiveMembership(membership: MembershipLike | null | undefined) {
  return membership?.status === "active";
}

export function canInviteMembers(membership: MembershipLike | null | undefined) {
  return isActiveMembership(membership) && membership?.role === "manager";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseInvitePayload(value: unknown): InviteRequest {
  if (!isRecord(value)) {
    throw new PolicyError("Request body must be a JSON object.");
  }

  if (value.role !== "analyst") {
    throw new PolicyError("role must be analyst.");
  }

  const email = normalizeEmail(value.email);
  if (!email) {
    throw new PolicyError("Enter a valid email address.");
  }

  return { email, role: "analyst" };
}

export function parseUploadRequest(value: unknown): UploadRequest {
  if (!isRecord(value) || typeof value.uploadId !== "string" || !uuidPattern.test(value.uploadId)) {
    throw new PolicyError("uploadId must be a valid UUID.");
  }

  return { uploadId: value.uploadId };
}
