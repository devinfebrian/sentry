const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
export const MAX_JSON_BODY_BYTES = 64 * 1024;

interface DenoEnvLike {
  env?: {
    get(name: string): string | undefined;
  };
}

function readEnv(name: string) {
  const deno = (globalThis as typeof globalThis & { Deno?: DenoEnvLike }).Deno;
  return deno?.env?.get(name);
}

// Loopback hosts are "potentially trustworthy" origins: a remote attacker cannot serve a
// page from the developer's own machine, so plain http is acceptable for these and only
// these. Matched against URL.hostname, which is the exact host - never a substring - so
// http://127.0.0.1.evil.example does not qualify. IPv6 hostnames keep their brackets.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function normalizeOrigin(value: string) {
  if (value === "*") {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.origin === "null") {
      return null;
    }
    if (parsed.protocol === "https:") {
      return parsed.origin;
    }
    return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function allowedOriginsFrom(value?: string, localDevelopment = true) {
  const configured = value?.split(",").map((origin) => normalizeOrigin(origin.trim())).filter((origin): origin is string => Boolean(origin));
  return configured && configured.length > 0 ? configured : localDevelopment ? DEFAULT_ALLOWED_ORIGINS : [];
}

export function isOriginAllowed(origin: string | null, allowedOrigins = allowedOriginsFrom()) {
  return origin === null || allowedOrigins.includes(origin);
}

function headersFor(request: Request, allowedOrigins: string[]) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  });
  const origin = request.headers.get("Origin");
  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "authorization, x-client-info, apikey, content-type");
  }
  return headers;
}

export function jsonResponse(body: unknown, status = 200, request?: Request, allowedOrigins = allowedOriginsFrom()) {
  const headers = request ? headersFor(request, allowedOrigins) : new Headers({ "Content-Type": "application/json; charset=utf-8" });
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorResponse(message: string, status: number, request: Request, allowedOrigins = allowedOriginsFrom()) {
  return jsonResponse({ error: message }, status, request, allowedOrigins);
}

export class HttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function handleCors(request: Request, allowedOrigins = allowedOriginsFrom()) {
  const origin = request.headers.get("Origin");
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return errorResponse("Origin not allowed.", 403, request, allowedOrigins);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headersFor(request, allowedOrigins) });
  }

  return null;
}

function isLocalDevelopment() {
  if (readEnv("DENO_DEPLOYMENT_ID")) {
    return false;
  }

  const supabaseUrl = readEnv("SUPABASE_URL");
  if (!supabaseUrl) {
    return true;
  }

  try {
    return ["localhost", "127.0.0.1", "::1", "kong"].includes(new URL(supabaseUrl).hostname);
  } catch {
    return false;
  }
}

async function readBodyText(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let bodyText = "";
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return bodyText + decoder.decode();
      }

      byteLength += value.byteLength;
      if (byteLength > MAX_JSON_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError("Request body too large.", 413);
      }

      bodyText += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function readJson(request: Request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError("Content-Type must be application/json.", 415);
  }

  const contentLengthHeader = request.headers.get("Content-Length");
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new HttpError("Request body too large.", 413);
  }

  let bodyText: string;
  try {
    bodyText = await readBodyText(request);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError("Request body must be valid JSON.", 400);
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new HttpError("Request body must be valid JSON.", 400);
  }
}

export function environmentAllowedOrigins() {
  return allowedOriginsFrom(readEnv("SENTINEL_ALLOWED_ORIGINS"), isLocalDevelopment());
}
