import { describe, expect, it } from "vitest";
import { fixtureCases, fixturePipeline } from "../demo/fixtures";

describe("fixtures", () => {
  it("contains all four ordered agent stages", () => {
    expect(fixturePipeline.map((stage) => stage.order)).toEqual([1, 2, 3, 4]);
    expect(fixturePipeline.map((stage) => stage.name)).toEqual([
      "Financial analysis investigator",
      "Fraud pattern investigator",
      "Evidence review and decision",
      "Reporting",
    ]);
  });

  it("links active cases to a stage", () => {
    expect(fixtureCases.every((item) => item.stageId.length > 0)).toBe(true);
  });
});
