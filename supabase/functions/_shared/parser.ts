export type ParserValue = string | number;

export interface ParsedImportRow {
  entity: string;
  values: Record<string, ParserValue>;
  sourceRow: number;
}

export interface ParsedImport {
  headers: string[];
  rows: ParsedImportRow[];
  warnings: string[];
}

/** Maximum uploaded byte length checked before spreadsheet expansion. */
export const MAX_INPUT_BYTES = 26_214_400;
/** Maximum extracted data rows checked before row construction. */
export const MAX_ROWS = 100_000;
/** Maximum columns in any extracted matrix row. */
export const MAX_COLUMNS = 256;
/** Maximum cells across the extracted matrix. */
export const MAX_CELLS = 2_000_000;
/** Maximum raw header or cell string length. */
export const MAX_CELL_LENGTH = 10_000;
/** Maximum ZIP entry count checked before spreadsheet expansion. */
export const MAX_ZIP_ENTRIES = 10_000;
/** Maximum summed ZIP entry uncompressed size checked before expansion. */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

interface SpreadsheetWorkbook {
  SheetNames: string[];
  Sheets: Record<string, unknown>;
}

export interface SpreadsheetModule {
  read(data: ArrayBuffer, options: { type: "array"; cellDates: true }): SpreadsheetWorkbook;
  utils: {
    sheet_to_json(sheet: unknown, options: { header: 1; defval: string }): unknown[][];
  };
}

export class SpreadsheetParseError extends Error {
  constructor() {
    super("Unable to parse spreadsheet. Verify it is a valid CSV, XLS, or XLSX file.");
    this.name = "SpreadsheetParseError";
  }
}

const valueHeaderPattern = /(amount|value|total|debit|credit|balance|transaction|cost|price)/i;

export function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

const numericTokenPattern = /^-?\$?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?$|^\$-?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?$/;

function canonicalDecimal(value: string) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [coefficient, exponentText] = unsigned.split(/[eE]/);
  const [integerPart, fractionPart = ""] = coefficient.split(".");
  const exponent = exponentText ? Number(exponentText) : 0;
  const digits = integerPart + fractionPart;
  const decimalIndex = integerPart.length + exponent;

  let whole: string;
  let fraction: string;
  if (decimalIndex <= 0) {
    whole = "0";
    fraction = `${"0".repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    whole = `${digits}${"0".repeat(decimalIndex - digits.length)}`;
    fraction = "";
  } else {
    whole = digits.slice(0, decimalIndex);
    fraction = digits.slice(decimalIndex);
  }

  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  fraction = fraction.replace(/0+$/, "");
  const isZero = whole === "0" && fraction === "";
  return `${negative && !isZero ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function isSafeNumericNumber(value: number) {
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function isExactSafeDecimalToken(text: string, numeric: number) {
  if (!isSafeNumericNumber(numeric)) {
    return false;
  }

  const canonicalToken = canonicalDecimal(text.replace(/[$,]/g, ""));
  if (canonicalDecimal(String(numeric)) !== canonicalToken) {
    return false;
  }

  const unsigned = canonicalToken.startsWith("-") ? canonicalToken.slice(1) : canonicalToken;
  const [whole, fraction = ""] = unsigned.split(".");
  const significantDigits = `${whole === "0" ? "" : whole}${fraction}`.replace(/^0+/, "") || "0";
  return BigInt(significantDigits) <= BigInt(Number.MAX_SAFE_INTEGER);
}

function normalizeValue(value: unknown, rowNumber: number, header: string, numericHeader: boolean): ParserValue {
  if (typeof value === "number") {
    if (Number.isFinite(value) && (!numericHeader || isSafeNumericNumber(value))) {
      return value;
    }
    if (numericHeader) {
      throw new Error(`Unsafe numeric value at row ${rowNumber}, header "${header}". Use a finite, safely representable amount.`);
    }
  }

  const text = String(value ?? "").trim();
  if (text === "") {
    return "";
  }

  if (numericHeader && !numericTokenPattern.test(text)) {
    throw new Error(`Invalid numeric value at row ${rowNumber}, header "${header}". Use a number with optional currency or comma separators.`);
  }

  const numeric = Number(text.replace(/[$,]/g, ""));
  if (numericHeader && !isExactSafeDecimalToken(text, numeric)) {
    throw new Error(`Unsafe numeric value at row ${rowNumber}, header "${header}". Use a finite, safely representable amount.`);
  }
  return Number.isFinite(numeric) && numericTokenPattern.test(text) ? numeric : text;
}

function isZipSignature(signature: number) {
  return signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x02014b50;
}

function findEndOfCentralDirectory(view: DataView) {
  if (view.byteLength < 22) {
    throw new Error("Malformed ZIP archive: end-of-central-directory record is truncated.");
  }

  const firstOffset = Math.max(0, view.byteLength - (22 + 0xffff));
  for (let offset = view.byteLength - 22; offset >= firstOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("Malformed ZIP archive: end-of-central-directory record not found.");
}

function preflightZip(data: ArrayBuffer) {
  const view = new DataView(data);
  const eocdOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("Malformed ZIP archive: multi-disk central directory is unsupported.");
  }
  if (totalEntries === 0xffff || centralDirectorySize === 0xffffffff || centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives and sentinel ZIP sizes are unsupported.");
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP archive exceeds maximum of ${MAX_ZIP_ENTRIES} entries. Remove extra files and try again.`);
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset > eocdOffset || centralDirectoryEnd > eocdOffset) {
    throw new Error("Malformed ZIP archive: central directory is outside archive bounds.");
  }

  let cursor = centralDirectoryOffset;
  let uncompressedBytes = 0;
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (cursor + 46 > centralDirectoryEnd) {
      throw new Error("Malformed ZIP archive: central directory entry is truncated.");
    }
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("Malformed ZIP archive: invalid central directory entry signature.");
    }

    const versionNeeded = view.getUint16(cursor + 6, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    if (versionNeeded >= 45 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || diskStart === 0xffff) {
      throw new Error("ZIP64 archives and sentinel ZIP sizes are unsupported.");
    }

    const entryEnd = cursor + 46 + fileNameLength + extraLength + commentLength;
    if (entryEnd > centralDirectoryEnd) {
      throw new Error("Malformed ZIP archive: central directory entry exceeds archive bounds.");
    }

    const extraStart = cursor + 46 + fileNameLength;
    const extraEnd = extraStart + extraLength;
    for (let extraOffset = extraStart; extraOffset < extraEnd;) {
      if (extraOffset + 4 > extraEnd) {
        throw new Error("Malformed ZIP archive: truncated central directory extra field.");
      }
      const extraType = view.getUint16(extraOffset, true);
      const extraSize = view.getUint16(extraOffset + 2, true);
      extraOffset += 4;
      if (extraOffset + extraSize > extraEnd) {
        throw new Error("Malformed ZIP archive: central directory extra field exceeds bounds.");
      }
      if (extraType === 0x0001) {
        throw new Error("ZIP64 archives and sentinel ZIP sizes are unsupported.");
      }
      extraOffset += extraSize;
    }

    if (uncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES - uncompressedSize) {
      throw new Error(`ZIP archive exceeds maximum uncompressed size of ${MAX_ZIP_UNCOMPRESSED_BYTES} bytes. Remove extra data and try again.`);
    }
    uncompressedBytes += uncompressedSize;
    cursor = entryEnd;
  }

  if (cursor !== centralDirectoryEnd) {
    throw new Error("Malformed ZIP archive: central directory size does not match entries.");
  }
}

function preflightInput(data: ArrayBuffer) {
  if (data.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`Input exceeds maximum input size of ${MAX_INPUT_BYTES} bytes. Remove extra data and try again.`);
  }
  if (data.byteLength < 4) {
    return;
  }
  const signature = new DataView(data).getUint32(0, true);
  if (isZipSignature(signature)) {
    preflightZip(data);
  }
}

export function parseImportMatrix(matrix: unknown[][], rowLimit = Number.POSITIVE_INFINITY): ParsedImport {
  const dataRowCount = Math.max(0, matrix.length - 1);
  if (dataRowCount > MAX_ROWS) {
    throw new Error(`Import exceeds maximum of ${MAX_ROWS} rows. Remove extra records and try again.`);
  }

  let cellCount = 0;
  matrix.forEach((row, rowIndex) => {
    if (row.length > MAX_COLUMNS) {
      throw new Error(`Row ${rowIndex + 1} exceeds maximum of ${MAX_COLUMNS} columns. Remove extra columns and try again.`);
    }
    cellCount += row.length;
    if (cellCount > MAX_CELLS) {
      throw new Error(`Import exceeds maximum of ${MAX_CELLS} cells. Remove extra data and try again.`);
    }
    row.forEach((value, columnIndex) => {
      if (String(value ?? "").length > MAX_CELL_LENGTH) {
        const location = rowIndex === 0 ? `Header at column ${columnIndex + 1}` : `Cell at row ${rowIndex + 1}, column ${columnIndex + 1}`;
        throw new Error(`${location} exceeds maximum length of ${MAX_CELL_LENGTH} characters. Shorten it and try again.`);
      }
    });
  });

  const rawHeaders = matrix[0] ?? [];
  const normalizedHeaders = rawHeaders.map(normalizeHeader);
  const entityIndex = normalizedHeaders.findIndex((header) => header === "entity" || header === "company" || header === "vendor");
  if (entityIndex < 0) {
    throw new Error("Missing required entity column. Rename one column Entity, Company, or Vendor.");
  }

  if (!normalizedHeaders.some((header) => valueHeaderPattern.test(header))) {
    throw new Error("Missing numeric transaction or value column. Add Amount, Total, Balance, or a similar field.");
  }

  const seenHeaders = new Set<string>();
  normalizedHeaders.forEach((header) => {
    if (!header) {
      return;
    }
    if (seenHeaders.has(header)) {
      throw new Error(`Duplicate header "${header}". Rename duplicate columns so each header is unique.`);
    }
    seenHeaders.add(header);
  });

  const headers = normalizedHeaders.filter(Boolean);

  matrix.slice(1).forEach((rawRow, rowIndex) => {
    normalizedHeaders.forEach((header, index) => {
      if (header && valueHeaderPattern.test(header)) {
        normalizeValue(rawRow[index], rowIndex + 2, header, true);
      }
    });
  });

  const warnings: string[] = [];
  const rows = matrix.slice(1).flatMap((rawRow, rowIndex) => {
    const entity = String(rawRow[entityIndex] ?? "").trim();
    if (!entity) {
      warnings.push(`Row ${rowIndex + 2} skipped because Entity is empty.`);
      return [];
    }

      const values: Record<string, ParserValue> = {};
      normalizedHeaders.forEach((header, index) => {
        if (header) {
          values[header] = normalizeValue(
            rawRow[index],
            rowIndex + 2,
            header,
            valueHeaderPattern.test(header),
          );
        }
      });

    return [{ entity, values, sourceRow: rowIndex + 2 }];
  });

  if (rows.length === 0) {
    throw new Error("No usable financial records found. Add an entity to at least one row.");
  }

  return { headers, rows: rows.slice(0, rowLimit), warnings };
}

export function parseWorkbook(
  data: ArrayBuffer,
  spreadsheet: SpreadsheetModule,
  rowLimit = Number.POSITIVE_INFINITY,
): ParsedImport {
  if (data.byteLength === 0) {
    throw new Error("Unable to parse empty spreadsheet.");
  }

  preflightInput(data);

  let workbook: SpreadsheetWorkbook;
  try {
    workbook = spreadsheet.read(data, { type: "array", cellDates: true });
  } catch {
    throw new SpreadsheetParseError();
  }
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("No worksheet found. Choose a file with financial records.");
  }

  const matrix = spreadsheet.utils.sheet_to_json(workbook.Sheets[firstSheetName], { header: 1, defval: "" });
  if (matrix.length < 2) {
    throw new Error("No financial records found. Add rows below your header row.");
  }

  return parseImportMatrix(matrix, rowLimit);
}

export function deduplicateRows(rows: ParsedImportRow[]) {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (seen.has(row.sourceRow)) {
      return false;
    }
    seen.add(row.sourceRow);
    return true;
  });
}
