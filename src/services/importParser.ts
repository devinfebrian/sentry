import * as XLSX from "xlsx";
import type { ImportRow } from "../domain/types";
import {
  parseWorkbook,
  SpreadsheetParseError,
  type SpreadsheetModule,
} from "../../supabase/functions/_shared/parser";
import { assertImportableBytes, assertImportableFile } from "./importFile";

export interface ImportPreview {
  headers: string[];
  rows: ImportRow[];
  warnings: string[];
}

/** The one seam between the shared parser and SheetJS in the browser. */
const spreadsheet: SpreadsheetModule = {
  read(data, options) {
    return XLSX.read(data, options) as unknown as ReturnType<SpreadsheetModule["read"]>;
  },
  utils: {
    sheet_to_json(sheet, options) {
      return XLSX.utils.sheet_to_json(sheet as XLSX.WorkSheet, options) as unknown[][];
    },
  },
};

function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("Unable to read selected file."));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Reads a selected file into normalized rows. Rejects with a message that names what the
 * analyst should change; the caller never has to interpret a parser fault.
 */
export async function parseImportFile(
  file: File,
  rowLimit = Number.POSITIVE_INFINITY,
): Promise<ImportPreview> {
  assertImportableFile(file);

  const bytes = await readFileBytes(file);
  assertImportableBytes(bytes.byteLength);

  try {
    return parseWorkbook(bytes, spreadsheet, rowLimit);
  } catch (error) {
    if (error instanceof SpreadsheetParseError) {
      throw new Error("Unable to parse selected file. Verify it is a valid CSV, XLS, or XLSX file.");
    }
    throw error;
  }
}
