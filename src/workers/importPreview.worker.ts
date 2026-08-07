import { parseImportFile } from "../services/importParser";
import type { ImportPreviewWorkerRequest, ImportPreviewWorkerResponse } from "./importPreview";

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<ImportPreviewWorkerRequest>) => void) | null;
  postMessage: (message: ImportPreviewWorkerResponse) => void;
};

workerScope.onmessage = async (event) => {
  if (event.data.type !== "preview") {
    return;
  }

  try {
    const preview = await parseImportFile(event.data.file, 5);
    workerScope.postMessage({ type: "ready", preview });
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : "Unable to preview selected file. Verify file format and try again.";
    workerScope.postMessage({ type: "error", message });
  }
};
