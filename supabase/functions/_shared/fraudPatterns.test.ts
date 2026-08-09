import { describe, expect, it, vi } from "vitest";
import type { ParsedImportRow } from "./parser";
import {
  analyseFraudPatterns,
  type FindingsModel,
  MAX_MODEL_ROWS,
  validateFindings,
} from "./fraudPatterns";

function row(sourceRow: number, entity: string, amount: number): ParsedImportRow {
  return { sourceRow, entity, values: { entity, amount } };
}

const rows = [row(2, "Northstar", 9400), row(3, "Northstar", 9600), row(4, "Meridian", 120)];

function evidence(sourceRow: number, relevance = "supporting") {
  return { sourceRow, claim: `Amount recorded on row ${sourceRow}`, relevance };
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    rule: "threshold-clustering",
    summary: "Two payments to Northstar fall just under 10,000",
    confidence: 0.7,
    evidence: [evidence(2), evidence(3)],
    ...overrides,
  };
}

/** Stands in for whichever provider is configured; the validator must not care. */
function fakeModel(payload: unknown) {
  const propose = vi.fn(async () => payload);
  return { model: { propose } as FindingsModel, propose };
}

describe("validateFindings", () => {
  it("keeps a finding whose evidence all cites real rows", () => {
    const [result] = validateFindings({ findings: [finding()] }, rows);

    expect(result.rule).toBe("threshold-clustering");
    expect(result.confidence).toBe(0.7);
    expect(result.evidence).toHaveLength(2);
  });

  it("drops evidence citing a row that was never imported", () => {
    // The model naming row 99 does not make row 99 exist. Everything downstream — the
    // ledger, the source link, the reader's trust — assumes the citation resolves.
    const [result] = validateFindings(
      { findings: [finding({ evidence: [evidence(2), evidence(99)] })] },
      rows,
    );

    expect(result.evidence.map((item) => item.sourceRow)).toEqual([2]);
  });

  it("drops a finding whose every citation was fabricated", () => {
    // Not a weaker finding — nothing at all. Rendering it would put an unsourced claim in
    // an evidence ledger whose whole premise is that claims are sourced.
    const results = validateFindings(
      { findings: [finding({ evidence: [evidence(98), evidence(99)] })] },
      rows,
    );

    expect(results).toEqual([]);
  });

  it("drops a finding supported only by context, with no supporting evidence", () => {
    const results = validateFindings(
      { findings: [finding({ evidence: [evidence(2, "context"), evidence(3, "context")] })] },
      rows,
    );

    expect(results).toEqual([]);
  });

  it("builds the source label from the row rather than from the model", () => {
    // A label the model wrote could describe a different row than the one it cited, and the
    // ledger shows the label. It is derived from the row we actually hold.
    const [result] = validateFindings(
      { findings: [finding({ evidence: [{ ...evidence(4), sourceLabel: "Row 4 — Northstar" }] })] },
      rows,
    );

    expect(result.evidence[0].sourceLabel).toBe("Row 4 — Meridian");
  });

  it("clamps confidence into the range the column accepts", () => {
    // numeric check (confidence >= 0 and confidence <= 1) — an out-of-range value would be
    // rejected by the database mid-transaction rather than by us.
    const [result] = validateFindings({ findings: [finding({ confidence: 4 })] }, rows);

    expect(result.confidence).toBe(1);
  });

  it("drops a finding the model gave zero confidence", () => {
    const results = validateFindings({ findings: [finding({ confidence: 0 })] }, rows);

    expect(results).toEqual([]);
  });

  it("drops findings missing a rule or a summary", () => {
    const results = validateFindings(
      { findings: [finding({ rule: "   " }), finding({ summary: "" })] },
      rows,
    );

    expect(results).toEqual([]);
  });

  it("normalises the rule into a slug", () => {
    const [result] = validateFindings({ findings: [finding({ rule: "Threshold Clustering!" })] }, rows);

    expect(result.rule).toBe("threshold-clustering");
  });

  it("survives a payload that is not shaped like findings at all", () => {
    // A response schema constrains shape but the payload still crosses a network. None of
    // these may take down the analysis.
    expect(validateFindings(null, rows)).toEqual([]);
    expect(validateFindings({ findings: "nope" }, rows)).toEqual([]);
    expect(validateFindings({ findings: [null, 7] }, rows)).toEqual([]);
  });
});

describe("analyseFraudPatterns", () => {
  it("returns findings from the model payload", async () => {
    const { model } = fakeModel({ findings: [finding()] });

    const results = await analyseFraudPatterns(model, ["entity", "amount"], rows);

    expect(results).toHaveLength(1);
    expect(results[0].agent).toBe("Fraud pattern investigator");
  });

  it("lets a model failure through rather than reporting zero findings", async () => {
    // "The model declined" and "the rows are clean" are different facts, and the run status
    // must not conflate them. The provider adapter decides which one happened; this layer
    // must not swallow it.
    const model = {
      propose: vi.fn(async () => {
        throw new Error("the model declined this request");
      }),
    } as FindingsModel;

    await expect(analyseFraudPatterns(model, ["entity", "amount"], rows)).rejects.toThrow(/declined/);
  });

  it("does not call the model when there is nothing to read", async () => {
    const { model, propose } = fakeModel({ findings: [] });

    expect(await analyseFraudPatterns(model, ["entity", "amount"], [])).toEqual([]);
    expect(await analyseFraudPatterns(model, [], rows)).toEqual([]);
    expect(propose).not.toHaveBeenCalled();
  });

  it("bounds the rows it sends and says the sample is partial", async () => {
    // The parser accepts up to 100,000 rows. An unbounded import must not become an
    // unbounded prompt, and a partial reading must not be presented as a whole one.
    const many = Array.from({ length: MAX_MODEL_ROWS + 50 }, (_, index) => row(index + 2, "Entity", index));
    const { model, propose } = fakeModel({ findings: [] });

    await analyseFraudPatterns(model, ["entity", "amount"], many);

    const { user } = propose.mock.calls[0][0];
    expect(user).toContain(`first ${MAX_MODEL_ROWS} of ${many.length}`);
    // The table is the last block; a header line plus one line per row sent.
    const table = (user.split("\n\n").at(-1) as string).trimEnd().split("\n");
    expect(table).toHaveLength(MAX_MODEL_ROWS + 1);
  });

  it("validates against the rows actually sent, not the full import", async () => {
    // A row beyond the sample was never shown to the model, so a citation of it is not a
    // real citation even though the row exists in the upload.
    const many = Array.from({ length: MAX_MODEL_ROWS + 50 }, (_, index) => row(index + 2, "Entity", index));
    const beyondSample = many[many.length - 1].sourceRow;
    const { model } = fakeModel({ findings: [finding({ evidence: [evidence(beyondSample)] })] });

    expect(await analyseFraudPatterns(model, ["entity", "amount"], many)).toEqual([]);
  });

  it("tells the model the deterministic rules already ran", async () => {
    // Without this the agent spends its findings re-reporting duplicates and outliers the
    // rules already proved with certainty.
    const { model, propose } = fakeModel({ findings: [] });

    await analyseFraudPatterns(model, ["entity", "amount"], rows);

    expect(propose.mock.calls[0][0].system).toContain("Do not repeat those");
  });
});
