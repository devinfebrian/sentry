import type { SentinelInvestigationService, SentinelUploadService, UploadParserResult } from "../domain/types";

import type { SentinelUploadRecovery } from "./sentinelUploads";

export interface ImportAccepted {
  status: "processing" | "parsed";
  investigationId: string;
  uploadId: string;
}

export interface ImportFailed {
  status: "failed";
  investigationId: string;
  uploadId: string;
  errorMessage: string;
  /** Present only when retrying means something other than "parse again". */
  retryLabel?: string;
  /** Re-runs the failed step against the upload that already exists. */
  retry: () => Promise<ImportOutcome>;
}

/**
 * Every ending the import has. A caller reads `status` and is done: a failure always
 * carries the reason and the way to retry, so there is no state to reconstruct.
 */
export type ImportOutcome = ImportAccepted | ImportFailed;

export interface ImportWorkflow {
  run(input: { file: File; entity: string }): Promise<ImportOutcome>;
}

export interface ImportWorkflowDependencies {
  investigations: Pick<SentinelInvestigationService, "create">;
  uploads: Pick<SentinelUploadService, "createUpload" | "startParsing" | "retryParsing">;
  ownerId: string;
}

/**
 * Recognises the recovery identity `createUpload` attaches when storage fails after the
 * upload row exists. Matched structurally rather than by `instanceof` so the shape stays
 * the contract even when the error crosses a module or test boundary.
 */
function getUploadRecovery(error: unknown): SentinelUploadRecovery | null {
  if (typeof error !== "object" || error === null || !("recovery" in error)) {
    return null;
  }

  const recovery = (error as { recovery?: unknown }).recovery;
  if (typeof recovery !== "object" || recovery === null) {
    return null;
  }

  const candidate = recovery as Partial<SentinelUploadRecovery>;
  return candidate.kind === "sentinel-upload-recovery"
    && typeof candidate.investigationId === "string"
    && typeof candidate.uploadId === "string"
    && typeof candidate.retryUpload === "function"
    ? candidate as SentinelUploadRecovery
    : null;
}

function getErrorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : error instanceof Error
      ? error.message
      : fallback;
}

/**
 * Turns a previewed file into an investigation with a parsing upload attached.
 *
 * Failures never strand work: once an upload row exists the outcome carries a `retry`
 * that resumes from the step that failed, so retrying can never create a second
 * investigation or a second upload for the same file.
 */
export function createImportWorkflow({
  investigations,
  uploads,
  ownerId,
}: ImportWorkflowDependencies): ImportWorkflow {
  const attemptParsing = (
    investigationId: string,
    uploadId: string,
    action: () => Promise<UploadParserResult>,
    retryAction: () => Promise<UploadParserResult>,
    retryLabel?: string,
  ): Promise<ImportOutcome> => {
    const retry = () => attemptParsing(investigationId, uploadId, retryAction, retryAction, retryLabel);

    return action().then(
      (parserResult): ImportOutcome => parserResult.status === "failed"
        ? {
          status: "failed",
          investigationId,
          uploadId,
          errorMessage: parserResult.errorMessage ?? "Parser failed. Retry this upload.",
          ...(retryLabel ? { retryLabel } : {}),
          retry,
        }
        : { status: parserResult.status, investigationId, uploadId },
      (caught: unknown): ImportOutcome => ({
        status: "failed",
        investigationId,
        uploadId,
        errorMessage: getErrorMessage(caught, "Unable to start parser. Retry this upload."),
        ...(retryLabel ? { retryLabel } : {}),
        retry,
      }),
    );
  };

  return {
    async run({ file, entity: requestedEntity }) {
      // The caller names the investigation. This used to be taken silently from the first
      // previewed row, which meant nobody could name their own case.
      const entity = requestedEntity.trim();
      if (!entity) {
        throw new Error("Unable to create investigation: no entity was given.");
      }

      const investigation = await investigations.create({ entity, ownerId });
      if (!investigation.databaseId) {
        throw new Error("Unable to start import: investigation database id is missing.");
      }

      try {
        const upload = await uploads.createUpload({ investigationId: investigation.databaseId, file });
        return await attemptParsing(
          investigation.id,
          upload.id,
          () => uploads.startParsing(upload.id),
          () => uploads.retryParsing(upload.id),
        );
      } catch (caught) {
        const recovery = getUploadRecovery(caught);
        // Only the recovery for this investigation is ours to resume; anything else is a
        // failure the caller has to see.
        if (!recovery || recovery.investigationId !== investigation.databaseId) {
          throw caught;
        }

        const retryUploadAndStartParser = async () => {
          await recovery.retryUpload();
          return uploads.startParsing(recovery.uploadId);
        };

        return {
          status: "failed",
          investigationId: investigation.id,
          uploadId: recovery.uploadId,
          errorMessage: getErrorMessage(caught, "Unable to upload file. Retry this upload."),
          retryLabel: "Retry upload and parsing",
          retry: () => attemptParsing(
            investigation.id,
            recovery.uploadId,
            retryUploadAndStartParser,
            retryUploadAndStartParser,
            "Retry upload and parsing",
          ),
        };
      }
    },
  };
}
