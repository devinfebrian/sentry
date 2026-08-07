import type { ImportPreview } from "../services/importParser";

export type ImportPreviewWorkerMessage =
  | { type: "preview"; file: File }
  | { type: "ready"; preview: ImportPreview }
  | { type: "error"; message: string };

export type ImportPreviewWorkerRequest = Extract<ImportPreviewWorkerMessage, { type: "preview" }>;
export type ImportPreviewWorkerResponse = Exclude<ImportPreviewWorkerMessage, ImportPreviewWorkerRequest>;

const PREVIEW_TIMEOUT_MS = 30_000;
const CANCELLATION_MESSAGE = "File preview cancelled.";
const INVALID_RESPONSE_MESSAGE = "Unable to receive a valid file preview. Try again.";

export interface PreviewImportOptions {
  signal?: AbortSignal;
}

function isWorkerResponse(value: unknown): value is ImportPreviewWorkerResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return type === "ready" || type === "error";
}

export function previewImport(file: File, options: PreviewImportOptions = {}): Promise<ImportPreview> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    let worker: Worker | undefined;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    };

    const resolvePreview = (preview: ImportPreview) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(preview);
    };

    const rejectPreview = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    abortListener = () => rejectPreview(new Error(CANCELLATION_MESSAGE));
    if (signal) {
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
        return;
      }
    }

    try {
      worker = new Worker(new URL("./importPreview.worker.ts", import.meta.url), { type: "module" });
    } catch {
      rejectPreview(new Error("Unable to start file preview. Try again."));
      return;
    }

    if (signal?.aborted) {
      abortListener();
      return;
    }

    worker.onmessage = (event: MessageEvent<ImportPreviewWorkerMessage>) => {
      const message: unknown = event.data;
      if (!isWorkerResponse(message)) {
        rejectPreview(new Error(INVALID_RESPONSE_MESSAGE));
      } else if (message.type === "ready") {
        resolvePreview(message.preview);
      } else if (message.type === "error") {
        const errorMessage = typeof message.message === "string" && message.message.trim()
          ? message.message
          : INVALID_RESPONSE_MESSAGE;
        rejectPreview(new Error(errorMessage));
      }
    };
    worker.onerror = () => {
      rejectPreview(new Error("Unable to preview selected file. Verify file format and try again."));
    };
    worker.onmessageerror = () => {
      rejectPreview(new Error("Unable to receive file preview. Try again."));
    };
    timeoutId = setTimeout(() => {
      rejectPreview(new Error("File preview timed out. Try again."));
    }, PREVIEW_TIMEOUT_MS);

    try {
      worker.postMessage({ type: "preview", file } satisfies ImportPreviewWorkerRequest);
    } catch {
      rejectPreview(new Error("Unable to send file for preview. Try again."));
    }
  });
}
