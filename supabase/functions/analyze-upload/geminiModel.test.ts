import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRefusalError, AgentUnavailableError } from "../_shared/fraudPatterns";
import { createGeminiModel, DEFAULT_GEMINI_MODEL, MissingModelKeyError } from "./geminiModel";

/**
 * These cover the provider seam: turning Google's response shapes into the two failure
 * kinds the run status distinguishes. Everything above the port is provider-agnostic and
 * lives in _shared/fraudPatterns.test.ts.
 */

const env = new Map<string, string>();

beforeEach(() => {
  env.clear();
  env.set("GEMINI_API_KEY", "test-key");
  (globalThis as { Deno?: unknown }).Deno = { env: { get: (name: string) => env.get(name) } };
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { Deno?: unknown }).Deno;
});

function respond(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function candidate(text: string, finishReason = "STOP") {
  return { candidates: [{ finishReason, content: { parts: [{ text }] } }] };
}

const request = { system: "system prompt", user: "user prompt" };

describe("createGeminiModel", () => {
  it("names the missing key rather than failing obscurely", () => {
    env.clear();

    expect(() => createGeminiModel()).toThrow(MissingModelKeyError);
  });

  it("accepts GOOGLE_API_KEY as well, since the same credential is stored under both names", () => {
    env.clear();
    env.set("GOOGLE_API_KEY", "test-key");

    expect(() => createGeminiModel()).not.toThrow();
  });

  it("returns the parsed findings payload", async () => {
    respond(candidate('{"findings":[{"rule":"round-numbers"}]}'));

    const payload = await createGeminiModel().propose(request);

    expect(payload).toEqual({ findings: [{ rule: "round-numbers" }] });
  });

  it("asks for JSON against a response schema", async () => {
    const fetchMock = respond(candidate('{"findings":[]}'));

    await createGeminiModel().propose(request);

    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toContain(`${DEFAULT_GEMINI_MODEL}:generateContent`);
    expect(init.headers["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(init.body);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toEqual(["findings"]);
    expect(body.system_instruction.parts[0].text).toBe("system prompt");
  });

  it("honours a per-project model override", async () => {
    env.set("GEMINI_MODEL", "gemini-custom");
    const fetchMock = respond(candidate('{"findings":[]}'));

    await createGeminiModel().propose(request);

    expect(fetchMock.mock.calls[0][0]).toContain("gemini-custom:generateContent");
  });

  it("treats a blocked prompt as a refusal", async () => {
    // A blocked prompt comes back as HTTP 200 with no candidate at all. Reading candidates
    // first would record "no findings" for rows nobody analysed — an error path falling
    // back to an empty success state, which hides itself perfectly.
    respond({ promptFeedback: { blockReason: "SAFETY" } });

    await expect(createGeminiModel().propose(request)).rejects.toBeInstanceOf(AgentRefusalError);
  });

  it("treats a safety finish reason as a refusal", async () => {
    respond(candidate("", "SAFETY"));

    await expect(createGeminiModel().propose(request)).rejects.toBeInstanceOf(AgentRefusalError);
  });

  it("treats a truncated response as unavailable, not as a refusal", async () => {
    // Different fact, different fix: the analyst can retry a truncation, and cannot argue
    // with a safety block.
    respond(candidate('{"findings":[', "MAX_TOKENS"));

    await expect(createGeminiModel().propose(request)).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("reports a rate limit in words an analyst can act on", async () => {
    respond({ error: { message: "quota exceeded" } }, { ok: false, status: 429 });

    await expect(createGeminiModel().propose(request)).rejects.toThrow(/rate limit/);
  });

  it("does not put the error body into the failure reason", async () => {
    // failure_reason is shown in the pipeline and stored in the activity log. Google echoes
    // request detail — including the key on some errors — into that body.
    respond({ error: { message: "API key not valid: test-key" } }, { ok: false, status: 400 });

    await expect(createGeminiModel().propose(request)).rejects.toThrow(/HTTP 400/);
    await expect(createGeminiModel().propose(request)).rejects.not.toThrow(/test-key/);
  });

  it("reports malformed JSON rather than validating a string as zero findings", async () => {
    respond(candidate("this is not json"));

    await expect(createGeminiModel().propose(request)).rejects.toThrow(/not valid JSON/);
  });

  it("reports an empty or candidate-less response", async () => {
    respond({ candidates: [] });
    await expect(createGeminiModel().propose(request)).rejects.toThrow(/no candidate/);

    respond(candidate("   "));
    await expect(createGeminiModel().propose(request)).rejects.toThrow(/empty response/);
  });

  it("reports a transport failure as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));

    await expect(createGeminiModel().propose(request)).rejects.toBeInstanceOf(AgentUnavailableError);
  });
});
