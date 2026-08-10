import type { ParsedImportRow } from "./parser.ts";
import type { AnalysisFinding, Severity } from "./analysis.ts";
import { AGENT_DESCRIPTORS } from "./agentKeys.ts";

/**
 * An AI pass over the same rows the deterministic rules already read.
 *
 * The rules state facts they can prove and emit confidence 1. This agent states patterns it
 * believes it sees, and its confidence is genuinely uncertain — which is why the schema
 * carried a 0..1 range from the start.
 *
 * The load-bearing rule in this file is not the prompt: it is validateFindings. A finding
 * that cites a row which does not exist is discarded rather than shown, because the whole
 * product rests on every claim tracing to a source row. A model that invents a row number
 * loses that finding, not the reader's trust.
 *
 * Which model produced the payload is deliberately not this file's business — see the
 * FindingsModel port below.
 */

/**
 * Rows sent to the model in one request. The parser accepts up to MAX_ROWS (100,000), which
 * is far past what belongs in a prompt. When an import exceeds this the agent analyses the
 * first slice and says so in its summaries, rather than silently reading part of the file
 * and presenting the result as if it covered all of it.
 */
export const MAX_MODEL_ROWS = 300;

export class AgentRefusalError extends Error {
  constructor(category?: string) {
    super(
      category
        ? `The analysis model declined this request (${category}). The rows were not analysed.`
        : "The analysis model declined this request. The rows were not analysed.",
    );
    this.name = "AgentRefusalError";
  }
}

export class AgentUnavailableError extends Error {
  constructor(detail?: string) {
    super(detail ? `The analysis model is unavailable: ${detail}` : "The analysis model is unavailable.");
    this.name = "AgentUnavailableError";
  }
}

export interface FindingsRequest {
  system: string;
  user: string;
}

/**
 * The seam between "what we ask" and "who we ask".
 *
 * An implementation returns whatever JSON payload the model produced and is responsible for
 * provider-specific failure shapes — a safety block, a truncated response, a transport
 * fault — which it reports as AgentRefusalError or AgentUnavailableError. Everything after
 * that point is provider-agnostic, so swapping models never touches the validation that the
 * evidence ledger depends on.
 */
export interface FindingsModel {
  propose(request: FindingsRequest): Promise<unknown>;
}

interface ModelEvidence {
  sourceRow: number;
  claim: string;
  relevance: "supporting" | "contradictory" | "context";
}

interface ModelFinding {
  rule: string;
  summary: string;
  confidence: number;
  severity: string;
  evidence: ModelEvidence[];
}

const systemPrompt = [
  "You are reviewing rows imported from a finance team's spreadsheet, looking for patterns a",
  "deterministic rule cannot express: clustering just under approval thresholds, near-duplicate",
  "entity names, sequences that look manufactured, timing patterns, round-number bias.",
  "",
  "Three deterministic rules have already run over these rows and reported exact duplicate amounts,",
  "amounts far above the median, and missing amounts. Do not repeat those — look for what they miss.",
  "",
  "State what the data shows, not what it means. \"Eleven payments to one supplier fall between 9,400",
  "and 9,900\" is a finding; \"the supplier is splitting invoices to evade approval\" is a conclusion",
  "the analyst draws. Cite the source row number of every row you rely on, exactly as given.",
  "",
  "Set confidence honestly: near 1 when the pattern is unmistakable in the rows, lower when it is",
  "suggestive. Severity is a separate judgement and must not track confidence: confidence is whether",
  "the pattern is really there, severity is how much it would matter if it is. A pattern can be",
  "unmistakable and minor. Report an empty findings array when the rows show nothing worth an",
  "analyst's attention — a clean import is a normal and useful result, and is better than padding",
  "the list with weak observations.",
].join("\n");

function serialiseRows(headers: string[], rows: ParsedImportRow[]) {
  const columns = ["sourceRow", "entity", ...headers];
  const lines = rows.map((row) =>
    [row.sourceRow, row.entity, ...headers.map((header) => row.values[header] ?? "")]
      .map((cell) => String(cell).replace(/\t/g, " "))
      .join("\t")
  );
  return [columns.join("\t"), ...lines].join("\n");
}

export function buildUserMessage(headers: string[], rows: ParsedImportRow[], totalRows: number) {
  const truncated = totalRows > rows.length;
  const preamble = truncated
    ? `These are the first ${rows.length} of ${totalRows} imported rows. Say so in any summary that `
      + "describes a count or proportion, so nobody reads a partial figure as a total."
    : `These are all ${rows.length} imported rows.`;

  return `${preamble}\n\nTab-separated, header row first:\n\n${serialiseRows(headers, rows)}`;
}

function clampConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // A model that reports 0 is saying it does not believe its own finding; drop it rather
  // than render a finding the producer disowns.
  if (value <= 0) return null;
  return Math.min(value, 1);
}

/**
 * Best-effort, unlike the fields above it. A finding whose severity is missing or outside
 * the enum is still a finding the analyst should see; it simply arrives unrated. Dropping a
 * real, well-evidenced finding over a bad enum value would lose more than it protects.
 */
function severityValue(value: unknown): Severity | null {
  return value === "low" || value === "medium" || value === "high" ? value : null;
}

function ruleSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 64) : null;
}

/**
 * Turns what the model said into what the database will accept, dropping anything that
 * cannot be traced back to a real row.
 *
 * Exported because this — not the prompt, and not the provider — is the guarantee the
 * product rests on, and it deserves to be tested directly against a fabricated response.
 */
export function validateFindings(raw: unknown, rows: ParsedImportRow[]): AnalysisFinding[] {
  const known = new Map(rows.map((row) => [row.sourceRow, row]));
  const candidates = Array.isArray((raw as { findings?: unknown })?.findings)
    ? ((raw as { findings: unknown[] }).findings)
    : [];

  const findings: AnalysisFinding[] = [];

  for (const candidate of candidates) {
    // A response schema makes a malformed entry unlikely, not impossible — and this runs on
    // whatever came back over the wire. A null here must drop one finding, not throw out
    // the whole analysis.
    if (typeof candidate !== "object" || candidate === null) continue;

    const finding = candidate as Partial<ModelFinding>;
    const rule = ruleSlug(finding.rule);
    const confidence = clampConfidence(finding.confidence);
    const summary = typeof finding.summary === "string" ? finding.summary.trim() : "";

    if (!rule || confidence === null || summary.length === 0) continue;

    const evidence = (Array.isArray(finding.evidence) ? finding.evidence : [])
      .map((item) => item as Partial<ModelEvidence>)
      .filter((item): item is ModelEvidence => {
        // The one check that matters: the row must exist in what we actually parsed.
        if (typeof item.sourceRow !== "number" || !known.has(item.sourceRow)) return false;
        if (typeof item.claim !== "string" || item.claim.trim().length === 0) return false;
        return item.relevance === "supporting"
          || item.relevance === "contradictory"
          || item.relevance === "context";
      })
      .map((item) => {
        const row = known.get(item.sourceRow) as ParsedImportRow;
        return {
          sourceRow: item.sourceRow,
          // Built from the row itself, never from the model. A label the model wrote could
          // describe a different row than the one it cited.
          sourceLabel: `Row ${row.sourceRow} — ${row.entity}`,
          claim: item.claim.trim(),
          relevance: item.relevance,
        };
      });

    // A finding whose every citation was fabricated is not a weaker finding, it is nothing.
    if (!evidence.some((item) => item.relevance === "supporting")) continue;

    findings.push({
      rule,
      agent: AGENT_DESCRIPTORS["fraud-pattern"].name,
      summary,
      confidence,
      severity: severityValue(finding.severity),
      evidence,
    });
  }

  return findings;
}

/**
 * Runs the agent over the parsed rows.
 *
 * Surfaces AgentRefusalError and AgentUnavailableError from the model rather than returning
 * an empty array, because "the model declined" and "the rows are clean" are different facts
 * and the run status must not conflate them.
 */
export async function analyseFraudPatterns(
  model: FindingsModel,
  headers: string[],
  rows: ParsedImportRow[],
): Promise<AnalysisFinding[]> {
  if (rows.length === 0 || headers.length === 0) return [];

  const sample = rows.slice(0, MAX_MODEL_ROWS);

  const payload = await model.propose({
    system: systemPrompt,
    user: buildUserMessage(headers, sample, rows.length),
  });

  // Validated against the sample, not the whole import: a row the model was never shown is
  // not something it can have cited, even though the row exists in the upload.
  return validateFindings(payload, sample);
}
