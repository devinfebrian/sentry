import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedOriginsFrom, environmentAllowedOrigins, handleCors, MAX_JSON_BODY_BYTES, readJson } from "./cors";

function jsonRequest(body: string, headers: HeadersInit = { "Content-Type": "application/json" }) {
  return new Request("http://localhost/functions/v1/test", {
    method: "POST",
    headers,
    body,
  });
}

function optionsRequest(origin: string) {
  return new Request("http://localhost/functions/v1/test", {
    method: "OPTIONS",
    headers: { Origin: origin },
  });
}

describe("hosted CORS configuration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("allows configured hosted origin and rejects unconfigured origin", async () => {
    vi.stubGlobal("Deno", {
      env: {
        get: (name: string) => ({ DENO_DEPLOYMENT_ID: "deployment-1", SENTINEL_ALLOWED_ORIGINS: "https://app.example" })[name],
      },
    });
    const allowedOrigins = environmentAllowedOrigins();

    expect(handleCors(optionsRequest("https://app.example"), allowedOrigins)?.status).toBe(204);
    expect(handleCors(optionsRequest("https://evil.example"), allowedOrigins)?.status).toBe(403);
  });

  it("rejects every origin when hosted configuration is absent or wildcard", async () => {
    const unconfiguredOrigins = allowedOriginsFrom(undefined, false);
    const wildcardOrigins = allowedOriginsFrom("*", false);

    expect(unconfiguredOrigins).toEqual([]);
    expect(allowedOriginsFrom(undefined, true)).toContain("http://localhost:5173");
    expect(handleCors(optionsRequest("https://app.example"), unconfiguredOrigins)?.status).toBe(403);
    expect(handleCors(optionsRequest("https://app.example"), wildcardOrigins)?.status).toBe(403);
  });

  it("rejects configured hosted HTTP origins", () => {
    const configuredOrigins = allowedOriginsFrom("http://example.com", false);

    expect(configuredOrigins).toEqual([]);
    expect(handleCors(optionsRequest("http://example.com"), configuredOrigins)?.status).toBe(403);
  });

  it("allows configured loopback HTTP origins so local dev can call hosted functions", () => {
    // Loopback is a W3C "potentially trustworthy" origin: a remote attacker cannot serve
    // a page from the developer's own localhost, so http is safe here specifically.
    for (const origin of ["http://127.0.0.1:5173", "http://localhost:5173", "http://[::1]:5173"]) {
      const configuredOrigins = allowedOriginsFrom(origin, false);

      expect(configuredOrigins).toEqual([origin]);
      expect(handleCors(optionsRequest(origin), configuredOrigins)?.status).toBe(204);
    }
  });

  it("rejects hostnames that merely embed a loopback label", () => {
    for (const origin of [
      "http://127.0.0.1.evil.example",
      "http://localhost.evil.example",
      "http://evil.example?x=localhost",
      "http://notlocalhost",
    ]) {
      expect(allowedOriginsFrom(origin, false)).toEqual([]);
    }
  });

  it("keeps a mixed allowlist of hosted HTTPS and loopback origins", () => {
    const configuredOrigins = allowedOriginsFrom("https://app.example, http://127.0.0.1:5173, http://plain.example", false);

    expect(configuredOrigins).toEqual(["https://app.example", "http://127.0.0.1:5173"]);
    expect(handleCors(optionsRequest("http://plain.example"), configuredOrigins)?.status).toBe(403);
  });

  it("uses hosted environment configuration instead of localhost fallback", () => {
    vi.stubGlobal("Deno", {
      env: {
        get: (name: string) => ({ DENO_DEPLOYMENT_ID: "deployment-1", SENTINEL_ALLOWED_ORIGINS: "https://app.example" })[name],
      },
    });

    expect(environmentAllowedOrigins()).toEqual(["https://app.example"]);
  });

  it("treats hosted Supabase URL without configuration as blocked", () => {
    vi.stubGlobal("Deno", {
      env: {
        get: (name: string) => ({ SUPABASE_URL: "https://project.supabase.co" })[name],
      },
    });

    expect(environmentAllowedOrigins()).toEqual([]);
  });
});

describe("bounded JSON request bodies", () => {
  it("rejects a content-length over the limit before consuming the body", async () => {
    const request = jsonRequest('{"uploadId":"upload-1"}', {
      "Content-Type": "application/json",
      "Content-Length": String(MAX_JSON_BODY_BYTES + 1),
    });

    await expect(readJson(request)).rejects.toMatchObject({
      status: 413,
      message: "Request body too large.",
    });
    expect(request.bodyUsed).toBe(false);
  });

  it("rejects a streamed body after the limit", async () => {
    const request = jsonRequest(`{"payload":"${"x".repeat(MAX_JSON_BODY_BYTES)}"}`);

    await expect(readJson(request)).rejects.toMatchObject({
      status: 413,
      message: "Request body too large.",
    });
  });

  it("preserves content-type and malformed JSON errors", async () => {
    await expect(readJson(new Request("http://localhost/functions/v1/test", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    }))).rejects.toMatchObject({ status: 415, message: "Content-Type must be application/json." });

    await expect(readJson(jsonRequest("{"))).rejects.toMatchObject({
      status: 400,
      message: "Request body must be valid JSON.",
    });
  });
});
