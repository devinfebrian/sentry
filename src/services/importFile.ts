import { MAX_INPUT_BYTES } from "../../supabase/functions/_shared/parser";

export const SUPPORTED_IMPORT_EXTENSIONS = ["csv", "xls", "xlsx"] as const;
export type ImportExtension = (typeof SUPPORTED_IMPORT_EXTENSIONS)[number];

export const UNSUPPORTED_EXTENSION_ERROR = "Choose a CSV, XLS, or XLSX financial data file.";
export const EMPTY_FILE_ERROR = "Selected file is empty. Choose a file with financial records.";
export const OVERSIZED_FILE_ERROR = "Selected file is too large. Maximum file size is 25 MB.";

const supported = new Set<string>(SUPPORTED_IMPORT_EXTENSIONS);

/** Strips any directory prefix a browser may report so paths cannot leak into storage keys. */
export function getFilenameLeaf(filename: string) {
  return filename.split(/[\\/]/).pop() || "upload";
}

function getExtension(filename: string) {
  const leaf = getFilenameLeaf(filename);
  const dotIndex = leaf.lastIndexOf(".");
  return dotIndex >= 0 ? leaf.slice(dotIndex + 1).toLowerCase() : "";
}

/**
 * The single gate every import path passes through, so the parser and the uploader
 * always agree on what a workspace will accept and say the same thing when they refuse.
 * Returns the validated extension because the uploader stores it alongside the file.
 */
export function assertImportableFile(file: { name: string; size: number }): ImportExtension {
  const extension = getExtension(file.name);
  if (!supported.has(extension)) {
    throw new Error(UNSUPPORTED_EXTENSION_ERROR);
  }
  if (file.size === 0) {
    throw new Error(EMPTY_FILE_ERROR);
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(OVERSIZED_FILE_ERROR);
  }
  return extension as ImportExtension;
}

/**
 * Re-checks the bytes actually read. File.size is a hint from the platform; the parser
 * would catch a mismatch but reports it as a spreadsheet fault rather than a file fault.
 */
export function assertImportableBytes(byteLength: number) {
  if (byteLength === 0) {
    throw new Error(EMPTY_FILE_ERROR);
  }
  if (byteLength > MAX_INPUT_BYTES) {
    throw new Error(OVERSIZED_FILE_ERROR);
  }
}
