import { describe, expect, it, vi } from "vitest";
import type { CaseSummary, UploadParserResult } from "../domain/types";
import { createImportWorkflow, type ImportFailed, type ImportOutcome } from "./importWorkflow";
import { SentinelUploadRecoveryError } from "./sentinelUploads";

const investigation = { id: "INV-1", databaseId: "db-inv-1" } as CaseSummary;
const upload = { id: "upload-1" };
const file = new File(["Entity,Amount\nNorthstar,50"], "ledger.csv", { type: "text/csv" });

const entity = "Northstar";

function makeWorkflow(overrides: {
  create?: ReturnType<typeof vi.fn>;
  createUpload?: ReturnType<typeof vi.fn>;
  startParsing?: ReturnType<typeof vi.fn>;
  retryParsing?: ReturnType<typeof vi.fn>;
} = {}) {
  const parsed: UploadParserResult = { uploadId: upload.id, status: "parsed" };
  const create = overrides.create ?? vi.fn().mockResolvedValue(investigation);
  const createUpload = overrides.createUpload ?? vi.fn().mockResolvedValue(upload);
  const startParsing = overrides.startParsing ?? vi.fn().mockResolvedValue(parsed);
  const retryParsing = overrides.retryParsing ?? vi.fn().mockResolvedValue(parsed);

  return {
    create,
    createUpload,
    startParsing,
    retryParsing,
    workflow: createImportWorkflow({
      investigations: { create },
      uploads: { createUpload, startParsing, retryParsing },
      ownerId: "user-1",
    }),
  };
}

function expectFailed(outcome: ImportOutcome): ImportFailed {
  if (outcome.status !== "failed") {
    throw new Error(`Expected a failed outcome, received "${outcome.status}".`);
  }
  return outcome;
}

describe("createImportWorkflow", () => {
  it("names the investigation from the caller, then uploads, then parses", async () => {
    const { workflow, create, createUpload, startParsing } = makeWorkflow();

    // A name the file could not have supplied: the workflow used to read the first
    // previewed row, so nobody could name their own case.
    const outcome = await workflow.run({ file, entity: "Renamed By Analyst" });

    expect(outcome).toEqual({ status: "parsed", investigationId: "INV-1", uploadId: "upload-1" });
    expect(create).toHaveBeenCalledWith({ entity: "Renamed By Analyst", ownerId: "user-1" });
    expect(createUpload).toHaveBeenCalledWith({ investigationId: "db-inv-1", file });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(createUpload.mock.invocationCallOrder[0]);
    expect(createUpload.mock.invocationCallOrder[0]).toBeLessThan(startParsing.mock.invocationCallOrder[0]);
  });

  it("reports a still-processing parser as accepted", async () => {
    const { workflow } = makeWorkflow({
      startParsing: vi.fn().mockResolvedValue({ uploadId: upload.id, status: "processing" }),
    });

    expect(await workflow.run({ file, entity })).toMatchObject({ status: "processing" });
  });

  it("refuses a blank entity before creating anything", async () => {
    const { workflow, create } = makeWorkflow();

    await expect(workflow.run({ file, entity: "   " })).rejects.toThrow(/no entity/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("trims the name it is given", async () => {
    const { workflow, create } = makeWorkflow();

    await workflow.run({ file, entity: "  Northwind Traders  " });

    expect(create).toHaveBeenCalledWith({ entity: "Northwind Traders", ownerId: "user-1" });
  });

  it("refuses to upload against an investigation with no database id", async () => {
    const { workflow, createUpload } = makeWorkflow({
      create: vi.fn().mockResolvedValue({ ...investigation, databaseId: undefined }),
    });

    await expect(workflow.run({ file, entity })).rejects.toThrow(/database id is missing/i);
    expect(createUpload).not.toHaveBeenCalled();
  });

  it("surfaces a reported parser failure with its reason", async () => {
    const { workflow } = makeWorkflow({
      startParsing: vi.fn().mockResolvedValue({ uploadId: upload.id, status: "failed", errorMessage: "Header row missing." }),
    });

    expect(expectFailed(await workflow.run({ file, entity }))).toMatchObject({
      status: "failed",
      uploadId: "upload-1",
      errorMessage: "Header row missing.",
    });
  });

  it("names a reason when the parser fails without one", async () => {
    const { workflow } = makeWorkflow({
      startParsing: vi.fn().mockResolvedValue({ uploadId: upload.id, status: "failed" }),
    });

    expect(expectFailed(await workflow.run({ file, entity })).errorMessage).toMatch(/retry this upload/i);
  });

  it("turns a thrown parser error into a retryable failure rather than rejecting", async () => {
    const { workflow } = makeWorkflow({
      startParsing: vi.fn().mockRejectedValue(new Error("Unable to start parsing: edge function down")),
    });

    expect(expectFailed(await workflow.run({ file, entity })).errorMessage).toMatch(/edge function down/i);
  });

  it("retries parsing against the existing upload without creating a second investigation", async () => {
    const { workflow, create, createUpload, retryParsing } = makeWorkflow({
      startParsing: vi.fn().mockResolvedValue({ uploadId: upload.id, status: "failed", errorMessage: "Parser failed." }),
    });

    const retried = await expectFailed(await workflow.run({ file, entity })).retry();

    expect(retried).toMatchObject({ status: "parsed", investigationId: "INV-1", uploadId: "upload-1" });
    expect(retryParsing).toHaveBeenCalledWith("upload-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(createUpload).toHaveBeenCalledTimes(1);
  });

  it("keeps offering a retry when the retry itself fails", async () => {
    const { workflow, createUpload } = makeWorkflow({
      startParsing: vi.fn().mockResolvedValue({ uploadId: upload.id, status: "failed", errorMessage: "Parser failed." }),
      retryParsing: vi.fn()
        .mockResolvedValueOnce({ uploadId: upload.id, status: "failed", errorMessage: "Still failing." })
        .mockResolvedValue({ uploadId: upload.id, status: "parsed" }),
    });

    const first = expectFailed(await workflow.run({ file, entity }));
    const second = expectFailed(await first.retry());

    expect(second.errorMessage).toBe("Still failing.");
    expect(await second.retry()).toMatchObject({ status: "parsed" });
    expect(createUpload).toHaveBeenCalledTimes(1);
  });

  it("recovers a storage failure by retrying the upload it already created", async () => {
    const retryUpload = vi.fn().mockResolvedValue(upload);
    const { workflow, create, createUpload, startParsing } = makeWorkflow({
      createUpload: vi.fn().mockRejectedValue(new SentinelUploadRecoveryError("Unable to upload file: storage denied", {
        kind: "sentinel-upload-recovery",
        investigationId: "db-inv-1",
        uploadId: "upload-1",
        retryUpload,
      })),
    });

    const failure = expectFailed(await workflow.run({ file, entity }));

    expect(failure).toMatchObject({
      investigationId: "INV-1",
      uploadId: "upload-1",
      errorMessage: "Unable to upload file: storage denied",
      retryLabel: "Retry upload and parsing",
    });

    expect(await failure.retry()).toMatchObject({ status: "parsed" });
    expect(retryUpload).toHaveBeenCalledTimes(1);
    expect(startParsing).toHaveBeenCalledWith("upload-1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(createUpload).toHaveBeenCalledTimes(1);
  });

  it("keeps the upload-and-parse label while that is still what a retry does", async () => {
    const retryUpload = vi.fn().mockResolvedValue(upload);
    const { workflow } = makeWorkflow({
      createUpload: vi.fn().mockRejectedValue(new SentinelUploadRecoveryError("storage denied", {
        kind: "sentinel-upload-recovery",
        investigationId: "db-inv-1",
        uploadId: "upload-1",
        retryUpload,
      })),
      startParsing: vi.fn().mockResolvedValue({ uploadId: upload.id, status: "failed", errorMessage: "Parser failed." }),
    });

    const retried = expectFailed(await expectFailed(await workflow.run({ file, entity })).retry());

    expect(retried.retryLabel).toBe("Retry upload and parsing");
  });

  it("rethrows an upload failure that carries no recovery identity", async () => {
    const { workflow } = makeWorkflow({
      createUpload: vi.fn().mockRejectedValue(new Error("Unable to create upload: row level security")),
    });

    await expect(workflow.run({ file, entity })).rejects.toThrow(/row level security/i);
  });

  it("rethrows a recovery that belongs to a different investigation", async () => {
    const { workflow } = makeWorkflow({
      createUpload: vi.fn().mockRejectedValue(new SentinelUploadRecoveryError("storage denied", {
        kind: "sentinel-upload-recovery",
        investigationId: "db-inv-OTHER",
        uploadId: "upload-1",
        retryUpload: vi.fn(),
      })),
    });

    await expect(workflow.run({ file, entity })).rejects.toThrow(/storage denied/i);
  });
});
