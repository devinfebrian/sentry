import {
  AgentRefusalError,
  AgentUnavailableError,
  type FindingsModel,
  type FindingsRequest,
} from "../_shared/fraudPatterns.ts";

/**
 * Google AI Studio (Gemini) behind the FindingsModel port.
 *
 * Plain fetch rather than an SDK: this is one request against a documented REST endpoint,
 * the Deno runtime has fetch natively, and it keeps the Edge Function's deploy graph to
 * files in this repo. Nothing here is Gemini-shaped above the port — swapping providers
 * means replacing this file and nothing else.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Overridable per project without a redeploy.
 *
 * Verified against this project's own account rather than assumed: appearing in ListModels
 * does not mean the account may call it. Both pro tiers — gemini-2.5-pro and
 * gemini-3-pro-preview — answer with HTTP 429 and `limit: 0`, which is not a temporary
 * exhaustion but "your tier does not include this model"; retrying never clears it. This
 * flash model answered cleanly and cited only rows that existed.
 *
 * If the project moves to a paid tier, a pro model is the upgrade worth testing — set
 * GEMINI_MODEL rather than editing this, and re-check that findings still cite real rows.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

/**
 * Generous because 2.5-series models spend part of the budget on internal reasoning before
 * emitting the JSON. Too small a ceiling surfaces as a truncated response, which this
 * adapter reports as a failure rather than as an empty analysis.
 */
export const MAX_OUTPUT_TOKENS = 16_000;

export class MissingModelKeyError extends Error {
  constructor() {
    super("GEMINI_API_KEY is not configured for this project.");
    this.name = "MissingModelKeyError";
  }
}

/**
 * Gemini's response schema is an OpenAPI subset: uppercase type names, no
 * additionalProperties, and `propertyOrdering` to keep generated fields in a stable order.
 * It constrains shape only — it cannot make a model cite a row that exists, which is what
 * validateFindings is for.
 */
const responseSchema = {
  type: "OBJECT",
  properties: {
    findings: {
      type: "ARRAY",
      description: "One entry per distinct pattern. Prefer few well-evidenced findings over many weak ones.",
      items: {
        type: "OBJECT",
        properties: {
          rule: {
            type: "STRING",
            description: "Short kebab-case label for the pattern, e.g. round-number-clustering.",
          },
          summary: {
            type: "STRING",
            description: "One sentence stating what the rows show, not a conclusion about wrongdoing.",
          },
          confidence: {
            type: "NUMBER",
            description: "Between 0 and 1. How sure you are the pattern is really present in these rows.",
          },
          evidence: {
            type: "ARRAY",
            description: "The rows that support the finding. Every finding needs at least one.",
            items: {
              type: "OBJECT",
              properties: {
                sourceRow: {
                  type: "INTEGER",
                  description: "The source row number exactly as given to you. Never invent one.",
                },
                claim: { type: "STRING", description: "What this specific row shows." },
                relevance: {
                  type: "STRING",
                  enum: ["supporting", "contradictory", "context"],
                },
              },
              required: ["sourceRow", "claim", "relevance"],
              propertyOrdering: ["sourceRow", "claim", "relevance"],
            },
          },
        },
        required: ["rule", "summary", "confidence", "evidence"],
        propertyOrdering: ["rule", "summary", "confidence", "evidence"],
      },
    },
  },
  required: ["findings"],
} as const;

/** Reasons Google gives for declining, as opposed to failing. */
const refusalReasons = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "RECITATION",
  "SPII",
  "BLOCKLIST",
  "IMAGE_SAFETY",
]);

function resolveKey() {
  // GEMINI_API_KEY is what AI Studio issues; GOOGLE_API_KEY is accepted because the same
  // credential is commonly stored under that name. Never a VITE_ variable — those are
  // compiled into the browser bundle.
  const key = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GOOGLE_API_KEY");
  if (!key) throw new MissingModelKeyError();
  return key;
}

export function createGeminiModel(): FindingsModel {
  const apiKey = resolveKey();
  const model = Deno.env.get("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL;

  return {
    async propose({ system, user }: FindingsRequest) {
      let response: Response;
      try {
        response = await fetch(`${API_ROOT}/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            },
          }),
        });
      } catch (error) {
        throw new AgentUnavailableError(error instanceof Error ? error.message : undefined);
      }

      if (!response.ok) {
        // The message body can carry an API key, so only the status is reported onward —
        // this string is written to failure_reason and shown to an analyst.
        throw new AgentUnavailableError(
          response.status === 429
            ? "the model's rate limit was reached. Try again shortly"
            : `the model returned HTTP ${response.status}`,
        );
      }

      let payload: {
        promptFeedback?: { blockReason?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
      };
      try {
        payload = await response.json();
      } catch {
        throw new AgentUnavailableError("the model returned a response that could not be read");
      }

      // Checked before reading candidates: a blocked prompt returns HTTP 200 with no
      // candidate at all, so reading content first would turn a refusal into zero findings.
      if (payload.promptFeedback?.blockReason) {
        throw new AgentRefusalError(payload.promptFeedback.blockReason);
      }

      const candidate = payload.candidates?.[0];
      if (!candidate) {
        throw new AgentUnavailableError("the model returned no candidate response");
      }

      if (candidate.finishReason && refusalReasons.has(candidate.finishReason)) {
        throw new AgentRefusalError(candidate.finishReason);
      }

      if (candidate.finishReason === "MAX_TOKENS") {
        throw new AgentUnavailableError("the response was cut off before the findings were complete");
      }

      const text = (candidate.content?.parts ?? []).map((part) => part.text ?? "").join("").trim();
      if (!text) {
        throw new AgentUnavailableError("the model returned an empty response");
      }

      try {
        return JSON.parse(text);
      } catch {
        // responseMimeType asks for JSON, so this means the response was malformed rather
        // than merely unexpected. Reporting it beats validating a string as zero findings.
        throw new AgentUnavailableError("the model returned findings that were not valid JSON");
      }
    },
  };
}
