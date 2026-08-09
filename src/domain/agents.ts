import type { AgentStage } from "./types";

/**
 * How each producer presents itself in the pipeline.
 *
 * Mirrors supabase/functions/_shared/agentKeys.ts. The two are separate because the Edge
 * Functions are Deno modules outside this tsconfig's program, and because they need
 * different things: the function needs the key list to seed runs, the app needs display
 * copy. What they share is the key strings, and those are pinned by a CHECK constraint on
 * sentinel_agent_runs.agent_key — a drifting key fails loudly at the database rather than
 * quietly here.
 */

export const AGENT_KEYS = ["deterministic", "fraud-pattern"] as const;

export type AgentKey = (typeof AGENT_KEYS)[number];

export interface AgentDescriptor {
  name: string;
  order: AgentStage["order"];
  description: string;
}

export const AGENT_DESCRIPTORS: Record<AgentKey, AgentDescriptor> = {
  "deterministic": {
    name: "Financial analysis",
    order: 1,
    description: "Deterministic rules over the imported rows. Every finding is certain.",
  },
  "fraud-pattern": {
    name: "Fraud pattern investigator",
    order: 2,
    description: "Reads the rows for patterns the rules cannot express. Findings carry confidence.",
  },
};

export function isAgentKey(value: unknown): value is AgentKey {
  return typeof value === "string" && (AGENT_KEYS as readonly string[]).includes(value);
}
