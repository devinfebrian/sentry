import { type ParsedImportRow, type ParserValue, valueHeaderPattern } from "./parser.ts";

/**
 * A first, deterministic pass over imported financial rows.
 *
 * Every finding states a fact about the data — "two rows share an entity and an amount" —
 * never a conclusion like "duplicate payment fraud". The reader draws the conclusion; the
 * analysis only says what it can prove from the rows in front of it.
 *
 * `confidence` exists because the domain type carries it for the AI agents the design spec
 * describes. Deterministic rules emit 1: the observation is certain even where its
 * significance is not. Inventing a plausible-looking 0.72 would be a fabrication.
 */

export type AnalysisRule = "duplicate-amount" | "outlier-amount" | "missing-amount";

export const ANALYSIS_AGENT = "Financial analysis";

/** A value must exceed the median by this factor before it is worth pointing at. */
export const OUTLIER_MULTIPLE = 4;

export interface AnalysisEvidence {
  sourceRow: number;
  sourceLabel: string;
  claim: string;
  relevance: "supporting" | "contradictory" | "context";
}

export interface AnalysisFinding {
  rule: AnalysisRule;
  agent: string;
  summary: string;
  confidence: number;
  evidence: AnalysisEvidence[];
}

function numeric(value: ParserValue | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The column the parser already required the import to have. */
export function findValueHeader(headers: string[]) {
  return headers.find((header) => valueHeaderPattern.test(header)) ?? null;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function amountLabel(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function rowLabel(row: ParsedImportRow) {
  return `Row ${row.sourceRow} — ${row.entity}`;
}

function duplicateAmounts(rows: ParsedImportRow[], header: string): AnalysisFinding[] {
  const groups = new Map<string, ParsedImportRow[]>();
  for (const row of rows) {
    const value = numeric(row.values[header]);
    if (value === null) continue;
    const key = `${row.entity.toLowerCase()}::${value}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const value = numeric(group[0].values[header]) as number;
      return {
        rule: "duplicate-amount" as const,
        agent: ANALYSIS_AGENT,
        summary: `${group.length} rows record ${amountLabel(value)} for ${group[0].entity}`,
        confidence: 1,
        evidence: group.map((row) => ({
          sourceRow: row.sourceRow,
          sourceLabel: rowLabel(row),
          claim: `${header} = ${amountLabel(value)}`,
          relevance: "supporting" as const,
        })),
      };
    });
}

function outlierAmounts(rows: ParsedImportRow[], header: string): AnalysisFinding[] {
  const valued = rows
    .map((row) => ({ row, value: numeric(row.values[header]) }))
    .filter((entry): entry is { row: ParsedImportRow; value: number } => entry.value !== null && entry.value > 0);

  // A median needs something to be a middle of; two rows cannot establish a norm.
  if (valued.length < 3) return [];

  const middle = median(valued.map((entry) => entry.value));
  if (middle <= 0) return [];

  const typical = valued.find((entry) => entry.value === middle) ?? valued[Math.floor(valued.length / 2)];

  return valued
    .filter((entry) => entry.value >= middle * OUTLIER_MULTIPLE)
    .map((entry) => ({
      rule: "outlier-amount" as const,
      agent: ANALYSIS_AGENT,
      summary: `${entry.row.entity} records ${amountLabel(entry.value)}, ${Math.round(entry.value / middle)}x the median of ${amountLabel(middle)}`,
      confidence: 1,
      evidence: [
        {
          sourceRow: entry.row.sourceRow,
          sourceLabel: rowLabel(entry.row),
          claim: `${header} = ${amountLabel(entry.value)}`,
          relevance: "supporting" as const,
        },
        // The typical row is what makes the outlier readable as an outlier.
        {
          sourceRow: typical.row.sourceRow,
          sourceLabel: rowLabel(typical.row),
          claim: `Median ${header} across this import is ${amountLabel(middle)}`,
          relevance: "context" as const,
        },
      ],
    }));
}

function missingAmounts(rows: ParsedImportRow[], header: string): AnalysisFinding[] {
  const affected = rows.filter((row) => {
    const raw = row.values[header];
    if (raw === undefined || raw === "") return true;
    return numeric(raw) === 0;
  });

  if (affected.length === 0) return [];

  return [{
    rule: "missing-amount" as const,
    agent: ANALYSIS_AGENT,
    summary: `${affected.length} ${affected.length === 1 ? "row has" : "rows have"} no ${header} recorded`,
    confidence: 1,
    evidence: affected.map((row) => ({
      sourceRow: row.sourceRow,
      sourceLabel: rowLabel(row),
      claim: `${header} is empty or zero`,
      relevance: "supporting" as const,
    })),
  }];
}

/**
 * Returns every finding the rules can prove. An empty array is a legitimate, common
 * outcome — a clean import has nothing to report, and saying so is more useful than
 * straining to produce something.
 */
export function analyseRows(headers: string[], rows: ParsedImportRow[]): AnalysisFinding[] {
  const header = findValueHeader(headers);
  if (!header || rows.length === 0) return [];

  return [
    ...duplicateAmounts(rows, header),
    ...outlierAmounts(rows, header),
    ...missingAmounts(rows, header),
  ];
}
