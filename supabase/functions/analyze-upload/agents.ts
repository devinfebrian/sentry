import type { ParsedImportRow } from "../_shared/parser.ts";
import type { AnalysisFinding } from "../_shared/analysis.ts";
import type { FindingsModel } from "../_shared/fraudPatterns.ts";
import type { AgentKey } from "../_shared/agentKeys.ts";
import { analyseRows } from "../_shared/analysis.ts";
import { analyseFraudPatterns } from "../_shared/fraudPatterns.ts";

/**
 * Binds each agent key to the code that produces its findings.
 *
 * The registry lives here rather than in _shared/agentKeys.ts because binding a key to an
 * implementation means importing that implementation — and parse-upload, which only needs
 * the key list, should not carry a model client in its deploy graph to get it.
 */

export interface AgentInput {
  headers: string[];
  rows: ParsedImportRow[];
  /**
   * Lazy so a deterministic run never needs an API key. Constructing eagerly would make the
   * rules fail on a project that has not configured the AI agent yet.
   */
  model: () => FindingsModel;
}

export type AgentProducer = (input: AgentInput) => Promise<AnalysisFinding[]>;

export const PRODUCERS: Record<AgentKey, AgentProducer> = {
  "deterministic": ({ headers, rows }) => Promise.resolve(analyseRows(headers, rows)),
  "fraud-pattern": ({ headers, rows, model }) => analyseFraudPatterns(model(), headers, rows),
};
