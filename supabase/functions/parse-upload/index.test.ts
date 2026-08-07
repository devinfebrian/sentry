import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSupabaseKey } from "../_shared/supabase-key";
import { allowedOriginsFrom, isOriginAllowed } from "../_shared/cors";
import {
  canInviteMembers,
  getBearerToken,
  isActiveMembership,
  normalizeEmail,
  parseInvitePayload,
  parseUploadRequest,
} from "../_shared/auth-policy";
import {
  deduplicateRows,
  MAX_INPUT_BYTES,
  MAX_CELL_LENGTH,
  MAX_CELLS,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  parseImportMatrix,
  parseWorkbook,
  type SpreadsheetModule,
} from "../_shared/parser";

function makeWorkbookBytes(sheets: Record<string, unknown[][]>) {
  const workbook = XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name, rows]) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  });
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

function makeZipBytes(options: {
  declaredEntries?: number;
  uncompressedSize?: number;
  centralDirectorySize?: number;
  centralDirectoryOffset?: number;
  centralSignature?: number;
  zip64?: boolean;
} = {}) {
  const centralDirectory = new Uint8Array(46);
  const centralView = new DataView(centralDirectory.buffer);
  centralView.setUint32(0, options.centralSignature ?? 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(24, options.zip64 ? 0xffffffff : options.uncompressedSize ?? 0, true);

  const centralDirectoryOffset = options.centralDirectoryOffset ?? 0;
  const centralDirectorySize = options.centralDirectorySize ?? centralDirectory.byteLength;
  const bytes = new Uint8Array(centralDirectory.byteLength + 22);
  bytes.set(centralDirectory, 0);
  const eocd = new DataView(bytes.buffer, centralDirectory.byteLength, 22);
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, options.zip64 ? 0xffff : options.declaredEntries ?? 1, true);
  eocd.setUint16(10, options.zip64 ? 0xffff : options.declaredEntries ?? 1, true);
  eocd.setUint32(12, centralDirectorySize, true);
  eocd.setUint32(16, centralDirectoryOffset, true);
  eocd.setUint16(20, 0, true);
  return bytes.buffer;
}

function spreadsheetStub(): SpreadsheetModule {
  return {
    read: vi.fn(() => {
      throw new Error("SheetJS read should not run after ZIP preflight rejection.");
    }),
    utils: { sheet_to_json: vi.fn() },
  };
}

describe("server import parser", () => {
  it("exports documented resource limits", () => {
    expect(MAX_INPUT_BYTES).toBe(26_214_400);
    expect(MAX_ROWS).toBe(100_000);
    expect(MAX_COLUMNS).toBe(256);
    expect(MAX_CELLS).toBe(2_000_000);
    expect(MAX_CELL_LENGTH).toBe(10_000);
    expect(MAX_ZIP_UNCOMPRESSED_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_ZIP_ENTRIES).toBe(10_000);
  });

  it("rejects input bytes above the limit before SheetJS read", () => {
    const spreadsheet = spreadsheetStub();

    expect(() => parseWorkbook(new ArrayBuffer(MAX_INPUT_BYTES + 1), spreadsheet)).toThrow(
      /maximum input size of 26214400 bytes/i,
    );
    expect(spreadsheet.read).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed central-directory range", makeZipBytes({ centralDirectorySize: 47 })],
    ["malformed central-directory signature", makeZipBytes({ centralSignature: 0x04034b50 })],
    ["ZIP64 sentinel metadata", makeZipBytes({ zip64: true })],
    ["too many ZIP entries", makeZipBytes({ declaredEntries: MAX_ZIP_ENTRIES + 1 })],
    ["excessive ZIP expansion", makeZipBytes({ uncompressedSize: MAX_ZIP_UNCOMPRESSED_BYTES + 1 })],
  ])("rejects %s before SheetJS read", (_label, bytes) => {
    const spreadsheet = spreadsheetStub();

    expect(() => parseWorkbook(bytes, spreadsheet)).toThrow(/ZIP|archive|central|entries|uncompressed/i);
    expect(spreadsheet.read).not.toHaveBeenCalled();
  });

  it("parses first worksheet and ignores later worksheets", () => {
    const result = parseWorkbook(
      makeWorkbookBytes({
        Summary: [
          ["Company", "Amount"],
          ["Northstar Ltd", "$1,200"],
        ],
        Ledger: [
          ["Entity", "Amount"],
          ["Wrong sheet", "50"],
        ],
      }),
      XLSX,
    );

    expect(result.rows).toEqual([
      { entity: "Northstar Ltd", values: { company: "Northstar Ltd", amount: 1200 }, sourceRow: 2 },
    ]);
  });

  it("normalizes headers case-insensitively and maps company/vendor headers", () => {
    const result = parseImportMatrix([
      ["  vEnDoR  ", "TRANSACTION_TOTAL", "Account-Name"],
      ["Orchid Supply", "$4,500", "INV-7"],
    ]);

    expect(result.headers).toEqual(["vendor", "transaction total", "account name"]);
    expect(result.rows[0]).toEqual({
      entity: "Orchid Supply",
      values: { vendor: "Orchid Supply", "transaction total": 4500, "account name": "INV-7" },
      sourceRow: 2,
    });
  });

  it("rejects duplicate non-empty normalized headers with an actionable error", () => {
    expect(() =>
      parseImportMatrix([
        ["Entity", "Amount", " amount "],
        ["Northstar", "10", "20"],
      ]),
    ).toThrow('Duplicate header "amount". Rename duplicate columns so each header is unique.');
  });

  it("omits blank headers without shifting row values", () => {
    const result = parseImportMatrix([
      ["Entity", "   ", "Amount"],
      ["Northstar", "not a returned value", "10"],
    ]);

    expect(result.headers).toEqual(["entity", "amount"]);
    expect(result.rows[0]).toEqual({
      entity: "Northstar",
      values: { entity: "Northstar", amount: 10 },
      sourceRow: 2,
    });
  });

  it.each(["amount", "value", "total", "debit", "credit", "balance", "transaction", "cost", "price"])(
    "accepts %s numeric header pattern",
    (header) => {
      expect(() => parseImportMatrix([["Entity", header], ["Northstar", "10"]])).not.toThrow();
    },
  );

  it("warns for blank entity rows while preserving source row numbers", () => {
    const result = parseImportMatrix([
      ["Entity", "Amount"],
      ["Northstar", "10"],
      ["", "20"],
      ["Orchid", "30"],
    ]);

    expect(result.rows.map((row) => row.sourceRow)).toEqual([2, 4]);
    expect(result.warnings).toEqual(["Row 3 skipped because Entity is empty."]);
  });

  it("rejects worksheets with no usable rows", () => {
    expect(() => parseImportMatrix([["Entity", "Amount"], ["", "10"]])).toThrow(/No usable financial records/i);
  });

  it("deduplicates duplicate source rows before conflict-safe persistence", () => {
    const rows = [
      { entity: "Northstar", values: { entity: "Northstar", amount: 10 }, sourceRow: 2 },
      { entity: "Northstar updated", values: { entity: "Northstar updated", amount: 20 }, sourceRow: 2 },
      { entity: "Orchid", values: { entity: "Orchid", amount: 30 }, sourceRow: 3 },
    ];

    expect(deduplicateRows(rows)).toEqual([rows[0], rows[2]]);
  });

  it("rejects malformed spreadsheet bytes", () => {
    expect(() => parseWorkbook(new ArrayBuffer(0), XLSX)).toThrow();
  });

  it("rejects extracted matrices beyond documented parser limits", () => {
    expect(() => parseImportMatrix([
      ["Entity", "Amount"],
      ...Array.from({ length: MAX_ROWS + 1 }, (_, index) => [`Entity ${index}`, "10"]),
    ])).toThrow(new RegExp(`maximum of ${MAX_ROWS} rows`, "i"));

    expect(() => parseImportMatrix([
      ["Entity", "Amount", ...Array.from({ length: MAX_COLUMNS - 1 }, (_, index) => `Column ${index}`)],
      ["Northstar", "10", ...Array.from({ length: MAX_COLUMNS - 1 }, () => "x")],
    ])).toThrow(new RegExp(`maximum of ${MAX_COLUMNS} columns`, "i"));

    expect(() => parseImportMatrix([
      ["Entity", "Amount"],
      ...Array.from({ length: MAX_ROWS }, (_, index) => [`Entity ${index}`, "10", ...Array.from({ length: 19 }, () => "x")]),
    ])).toThrow(new RegExp(`maximum of ${MAX_CELLS} cells`, "i"));

    expect(() => parseImportMatrix([["Entity", "A".repeat(MAX_CELL_LENGTH + 1)], ["Northstar", "10"]]))
      .toThrow(new RegExp(`header.*${MAX_CELL_LENGTH}`, "i"));
    expect(() => parseImportMatrix([["Entity", "Amount"], ["Northstar", "x".repeat(MAX_CELL_LENGTH + 1)]]))
      .toThrow(new RegExp(`cell.*${MAX_CELL_LENGTH}`, "i"));
  });

  it.each(["12abc", "$1,2x0", "1.2.3"])("rejects malformed numeric value %s with row and header", (value) => {
    expect(() => parseImportMatrix([["Entity", "Amount"], ["Northstar", value]])).toThrow(
      /Invalid numeric value at row 2, header "amount"/i,
    );
  });

  it("rejects malformed numeric values even on rows skipped for blank entity", () => {
    expect(() => parseImportMatrix([
      ["Entity", "Amount"],
      ["", "not-a-number"],
      ["Northstar", "10"],
    ])).toThrow(/Invalid numeric value at row 2, header "amount"/i);
  });

  it("preserves supported numeric strings, currency, commas, and numeric values", () => {
    const result = parseImportMatrix([
      ["Entity", "Amount"],
      ["Northstar", "$1,200"],
      ["Orchid", "-2,500.50"],
      ["Cedar", 30],
    ]);

    expect(result.rows.map((row) => row.values.amount)).toEqual([1200, -2500.5, 30]);
  });

  it("accepts exact arbitrary decimals and rejects unsafe or inexact amounts", () => {
    const result = parseImportMatrix([
      ["Entity", "Amount"],
      ["Northstar", "0.123456789012345"],
      ["Orchid", "0.00000000000000001"],
    ]);

    expect(result.rows.map((row) => row.values.amount)).toEqual([0.123456789012345, 0.00000000000000001]);

    for (const value of ["9007199254740992", "9007199254740991.1", "0.12345678901234567", "9999999999999999999999999999"]) {
      expect(() => parseImportMatrix([["Entity", "Amount"], ["Northstar", value]])).toThrow(
        /Unsafe numeric value at row 2, header "amount"/i,
      );
    }
  });
});

describe("request and authorization policy", () => {
  it("normalizes and validates invite email and fixed analyst role", () => {
    expect(normalizeEmail("  Analyst@Example.COM ")).toBe("analyst@example.com");
    expect(parseInvitePayload({ email: "Analyst@Example.COM", role: "analyst" })).toEqual({
      email: "analyst@example.com",
      role: "analyst",
    });
    expect(() => parseInvitePayload({ email: "analyst@example.com", role: "manager" })).toThrow(/role/i);
    expect(() => parseInvitePayload({ email: "not-an-email", role: "analyst" })).toThrow(/email/i);
  });

  it("requires bearer token and validates upload UUID request", () => {
    expect(getBearerToken(null)).toBeNull();
    expect(getBearerToken("Basic secret")).toBeNull();
    expect(getBearerToken("Bearer access-token")).toBe("access-token");
    expect(parseUploadRequest({ uploadId: "550e8400-e29b-41d4-a716-446655440000" })).toEqual({
      uploadId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(() => parseUploadRequest({ uploadId: "not-a-uuid" })).toThrow(/UUID/i);
  });

  it("allows only active managers to invite members", () => {
    expect(isActiveMembership({ status: "active", role: "manager" })).toBe(true);
    expect(canInviteMembers({ status: "active", role: "manager" })).toBe(true);
    expect(canInviteMembers({ status: "active", role: "analyst" })).toBe(false);
    expect(canInviteMembers({ status: "pending", role: "manager" })).toBe(false);
    expect(isActiveMembership(null)).toBe(false);
  });

  it("keeps CORS allowlist exact and never permits wildcard", () => {
    const origins = allowedOriginsFrom("https://sentinel.example, *");

    expect(isOriginAllowed("https://sentinel.example", origins)).toBe(true);
    expect(isOriginAllowed("https://other.example", origins)).toBe(false);
    expect(isOriginAllowed("*", origins)).toBe(false);
  });
});

describe("hosted Supabase key resolution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects default publishable key from hosted JSON dictionary", () => {
    vi.stubGlobal("Deno", {
      env: { get: (name: string) => ({
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "publishable-default", browser: "publishable-browser" }),
      })[name] },
    });

    expect(resolveSupabaseKey("SUPABASE_PUBLISHABLE_KEYS", ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"])).toBe(
      "publishable-default",
    );
  });

  it("selects default secret key from hosted JSON dictionary", () => {
    vi.stubGlobal("Deno", {
      env: { get: (name: string) => ({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: "secret-default" }) })[name] },
    });

    expect(resolveSupabaseKey("SUPABASE_SECRET_KEYS", ["SUPABASE_SERVICE_ROLE_KEY"])).toBe("secret-default");
  });

  it.each([
    ["SUPABASE_PUBLISHABLE_KEY", ["SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY"], "legacy-publishable"],
    ["SUPABASE_ANON_KEY", ["SUPABASE_PUBLISHABLE_KEYS"], "legacy-anon"],
    ["SUPABASE_SERVICE_ROLE_KEY", ["SUPABASE_SECRET_KEYS"], "legacy-service-role"],
  ])("falls back to direct %s when hosted dictionary is absent", (directName, otherNames, expected) => {
    vi.stubGlobal("Deno", {
      env: { get: (name: string) => ({ [directName]: expected })[name] },
    });

    expect(resolveSupabaseKey(otherNames[0], otherNames.slice(1).concat(directName))).toBe(expected);
  });

  it.each([
    ["publishable", "SUPABASE_PUBLISHABLE_KEYS", ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]],
    ["secret", "SUPABASE_SECRET_KEYS", ["SUPABASE_SERVICE_ROLE_KEY"]],
  ])("rejects malformed or missing default %s hosted dictionary", (_label, dictionaryName, directNames) => {
    vi.stubGlobal("Deno", {
      env: { get: (name: string) => ({ [dictionaryName]: "{" })[name] },
    });

    expect(() => resolveSupabaseKey(dictionaryName, directNames)).toThrow("Server authentication is unavailable.");

    vi.stubGlobal("Deno", {
      env: { get: (name: string) => ({ [dictionaryName]: JSON.stringify({ named: "key" }) })[name] },
    });

    expect(() => resolveSupabaseKey(dictionaryName, directNames)).toThrow("Server authentication is unavailable.");
  });

  it.each([
    ["publishable", "SUPABASE_PUBLISHABLE_KEYS", ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]],
    ["secret", "SUPABASE_SECRET_KEYS", ["SUPABASE_SERVICE_ROLE_KEY"]],
  ])("rejects missing %s hosted dictionary and direct fallback", (_label, dictionaryName, directNames) => {
    vi.stubGlobal("Deno", { env: { get: () => undefined } });

    expect(() => resolveSupabaseKey(dictionaryName, directNames)).toThrow("Server authentication is unavailable.");
  });
});
