import { describe, expect, it } from "vitest";
import { analyseRows, findValueHeader, OUTLIER_MULTIPLE } from "./analysis.ts";
import type { ParsedImportRow } from "./parser.ts";

const headers = ["entity", "amount"];

function row(entity: string, amount: number | string | undefined, sourceRow: number): ParsedImportRow {
  return {
    entity,
    values: amount === undefined ? { entity } : { entity, amount },
    sourceRow,
  };
}

/** Nine near-identical small values so the median is unambiguous. */
function baseline(count = 9, value = 100) {
  return Array.from({ length: count }, (_, index) => row(`Entity ${index + 1}`, value, index + 2));
}

describe("findValueHeader", () => {
  it("picks the money column the parser already validated", () => {
    expect(findValueHeader(["entity", "amount"])).toBe("amount");
    expect(findValueHeader(["vendor", "total cost"])).toBe("total cost");
    expect(findValueHeader(["entity", "reference"])).toBeNull();
  });
});

describe("analyseRows", () => {
  it("reports nothing for a clean import", () => {
    // The common case. Straining to produce a finding here would be worse than silence.
    expect(analyseRows(headers, [row("Acme", 100, 2), row("Beta", 120, 3), row("Gamma", 90, 4)])).toEqual([]);
  });

  it("reports nothing when there is no money column to read", () => {
    expect(analyseRows(["entity", "reference"], [row("Acme", 100, 2)])).toEqual([]);
  });

  it("reports nothing for an empty import", () => {
    expect(analyseRows(headers, [])).toEqual([]);
  });

  describe("duplicate-amount", () => {
    it("states the fact, not a conclusion about it", () => {
      const findings = analyseRows(headers, [row("Acme", 250, 2), row("Acme", 250, 5), row("Beta", 300, 3)]);
      const duplicate = findings.find((finding) => finding.rule === "duplicate-amount");

      expect(duplicate?.summary).toBe("2 rows record 250 for Acme");
      expect(duplicate?.confidence).toBe(1);
      expect(duplicate?.evidence.map((item) => item.sourceRow)).toEqual([2, 5]);
      expect(duplicate?.evidence.every((item) => item.relevance === "supporting")).toBe(true);
    });

    it("does not treat the same amount for different entities as a duplicate", () => {
      const findings = analyseRows(headers, [row("Acme", 250, 2), row("Beta", 250, 3)]);

      expect(findings.filter((finding) => finding.rule === "duplicate-amount")).toEqual([]);
    });

    it("matches entities case-insensitively", () => {
      const findings = analyseRows(headers, [row("Acme", 250, 2), row("ACME", 250, 3)]);

      expect(findings.some((finding) => finding.rule === "duplicate-amount")).toBe(true);
    });
  });

  describe("outlier-amount", () => {
    it("names the multiple and cites the median row as context", () => {
      const findings = analyseRows(headers, [...baseline(), row("Whale", 100 * OUTLIER_MULTIPLE, 20)]);
      const outlier = findings.find((finding) => finding.rule === "outlier-amount");

      expect(outlier?.summary).toMatch(/Whale records 400, 4x the median of 100/);
      expect(outlier?.evidence).toHaveLength(2);
      expect(outlier?.evidence[0]).toMatchObject({ sourceRow: 20, relevance: "supporting" });
      expect(outlier?.evidence[1].relevance).toBe("context");
    });

    it("leaves a value just under the threshold alone", () => {
      const findings = analyseRows(headers, [...baseline(), row("Nearly", 100 * OUTLIER_MULTIPLE - 1, 20)]);

      expect(findings.filter((finding) => finding.rule === "outlier-amount")).toEqual([]);
    });

    it("stays silent when there are too few rows to establish a norm", () => {
      // Two rows have no meaningful middle; calling one an outlier would be noise.
      const findings = analyseRows(headers, [row("Acme", 10, 2), row("Whale", 100000, 3)]);

      expect(findings.filter((finding) => finding.rule === "outlier-amount")).toEqual([]);
    });
  });

  describe("missing-amount", () => {
    it("counts blank and zero values together", () => {
      const findings = analyseRows(headers, [row("Acme", 0, 2), row("Beta", "", 3), row("Gamma", 100, 4)]);
      const missing = findings.find((finding) => finding.rule === "missing-amount");

      expect(missing?.summary).toBe("2 rows have no amount recorded");
      expect(missing?.evidence.map((item) => item.sourceRow)).toEqual([2, 3]);
    });

    it("treats an absent column value as missing", () => {
      const findings = analyseRows(headers, [row("Acme", undefined, 2), row("Beta", 100, 3)]);

      expect(findings.find((finding) => finding.rule === "missing-amount")?.summary)
        .toBe("1 row has no amount recorded");
    });

    it("stays silent when every row has an amount", () => {
      const findings = analyseRows(headers, [row("Acme", 100, 2), row("Beta", 120, 3)]);

      expect(findings.filter((finding) => finding.rule === "missing-amount")).toEqual([]);
    });
  });

  it("reports every rule that applies to the same import", () => {
    const findings = analyseRows(headers, [
      ...baseline(),
      row("Acme", 250, 20),
      row("Acme", 250, 21),
      row("Whale", 100 * OUTLIER_MULTIPLE, 22),
      row("Blank", 0, 23),
    ]);

    expect(new Set(findings.map((finding) => finding.rule)))
      .toEqual(new Set(["duplicate-amount", "outlier-amount", "missing-amount"]));
  });
});
