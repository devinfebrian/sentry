/**
 * The producers that may write findings, and how they present themselves.
 *
 * Deliberately free of dependencies. parse-upload needs the key list to seed run rows, but
 * has no business pulling an AI SDK into its import graph to get it — Edge Function deploys
 * inline the whole graph, so an import here is weight on every parse.
 *
 * These keys are mirrored by a CHECK constraint on sentinel_findings.agent_key and
 * sentinel_agent_runs.agent_key. Adding a producer means a migration, on purpose: an
 * agent_key the database does not recognise would own no findings and fail silently.
 *
 * sentinel_investigation_queue's stage derivation is a second place that migration has to
 * touch — its `count(*) filter (where r.agent_key = 'deterministic' ...)` and
 * `... = 'fraud-pattern' ...` arms are hardcoded to these two keys, so a third producer
 * would never gate 'awaiting-analysis' or 'fraud-review' and every case would jump straight
 * to 'analysed' the moment the other two finished.
 */

export const AGENT_KEYS = ["deterministic", "fraud-pattern"] as const;

export type AgentKey = (typeof AGENT_KEYS)[number];

export interface AgentDescriptor {
  key: AgentKey;
  /** Written to sentinel_findings.agent, and read by the evidence ledger. */
  name: string;
  /** Position in the pipeline. The design spec's stage order. */
  order: number;
  /** Shown under the stage name so a reader knows what this agent can and cannot prove. */
  description: string;
}

export const AGENT_DESCRIPTORS: Record<AgentKey, AgentDescriptor> = {
  "deterministic": {
    key: "deterministic",
    // Unchanged from the original single-producer analysis: existing findings carry this
    // exact string, and renaming it would rewrite history in the evidence ledger.
    name: "Financial analysis",
    order: 1,
    description: "Deterministic rules over the imported rows. Every finding is certain.",
  },
  "fraud-pattern": {
    key: "fraud-pattern",
    name: "Fraud pattern investigator",
    order: 2,
    description: "Reads the rows for patterns the rules cannot express. Findings carry confidence.",
  },
};

export const ORDERED_AGENT_KEYS: readonly AgentKey[] = [...AGENT_KEYS].sort(
  (left, right) => AGENT_DESCRIPTORS[left].order - AGENT_DESCRIPTORS[right].order,
);

export function isAgentKey(value: unknown): value is AgentKey {
  return typeof value === "string" && (AGENT_KEYS as readonly string[]).includes(value);
}
