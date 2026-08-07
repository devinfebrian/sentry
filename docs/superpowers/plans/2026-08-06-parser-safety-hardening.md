# Parser Safety Hardening Implementation Plan

> **For agentic workers:** Execute inline with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Harden server and browser financial import parsers against oversized inputs, ZIP expansion, matrix resource exhaustion, malformed numeric tokens, and unsafe numeric precision while preserving existing valid import behavior.

**Architecture:** Keep server parser as source of truth for shared limits and normalization behavior. Add a byte gate and ZIP central-directory preflight before `XLSX.read`, then validate extracted matrices before row construction. Mirror the same exported limits and numeric normalization rules in browser parser code without changing UI or persistence shape.

**Tech Stack:** TypeScript, Vitest, SheetJS `xlsx`, Supabase Edge Function-compatible runtime, browser Worker parser.

## Global Constraints

- Maximum input bytes: `26214400`.
- Maximum extracted rows: `100000` data rows.
- Maximum columns: `256` per matrix row.
- Maximum matrix cells: `2000000`.
- Maximum cell/header length: `10000` characters.
- Maximum ZIP uncompressed bytes: `100 MiB`.
- Maximum ZIP entries: `10000`.
- ZIP central-directory metadata must be validated before `XLSX.read`.
- CSV remains supported; ZIP preflight applies only to ZIP/XLSX byte signatures.
- First worksheet selection and `sourceRow` numbering remain unchanged.
- Numeric columns accept existing currency/comma/negative forms and numeric values.
- Non-empty numeric tokens must be finite, safe, and exact decimal round-trips; malformed or unsafe values include row and normalized header in errors.
- Duplicate non-empty headers, blank header omission, entity/value header requirements, blank entity warnings, and row shape remain unchanged.
- No schema, UI, remote push/deploy, or commit changes.

---

### Task 1: Add Server RED Coverage

**Files:**
- Modify: `supabase/functions/parse-upload/index.test.ts`

**Interfaces:**
- Import all seven exported parser limits plus `parseWorkbook` and `parseImportMatrix`.
- Build valid XLSX bytes with SheetJS and synthetic ZIP bytes with little-endian ZIP records.

- [ ] **Step 1: Add failing limit and ZIP tests**

Add tests that assert exported constants equal the exact required values; input over `MAX_INPUT_BYTES` is rejected before the spreadsheet module `read` call; malformed central-directory offset/size, ZIP64 sentinel fields, more than `MAX_ZIP_ENTRIES`, and summed uncompressed size over `MAX_ZIP_UNCOMPRESSED_BYTES` are rejected before `read`; valid XLSX still parses. Add extracted matrix tests for rows, columns, cells, header length, and cell length with actionable messages.

- [ ] **Step 2: Add failing numeric safety tests**

Add valid cases for `$1,200`, `-2,500.50`, ordinary numbers, and arbitrary exact decimal values. Add malformed token cases and unsafe/inexact cases such as `9007199254740992`, `9007199254740991.1`, and an overflowing exponent-like token rejected with `row 2` and normalized `amount` in the error. Keep blank numeric cells valid.

- [ ] **Step 3: Run RED**

Run:

```text
npm test -- --run supabase/functions/parse-upload/index.test.ts
```

Expected: new byte, ZIP, and numeric-safety assertions fail because production parser lacks those checks; existing assertions remain diagnostic.

### Task 2: Add Browser Parity RED Coverage

**Files:**
- Modify: `src/services/importData.test.ts`

**Interfaces:**
- Import shared browser limits from `src/services/importData.ts`.
- Exercise `parseImportFile` with CSV and XLSX `File` objects.

- [ ] **Step 1: Add failing browser tests**

Add parity cases for over-limit bytes, extracted row/column/cell/header/value limits, malformed numeric values, unsafe/inexact numeric values, and valid CSV/XLSX currency/comma/decimal cases. Assert browser errors match server wording where practical and assert valid output retains `{ entity, values, sourceRow }`.

- [ ] **Step 2: Run RED**

Run:

```text
npm test -- --run src/services/importData.test.ts
```

Expected: new parity assertions fail for missing browser resource and numeric-safety checks.

### Task 3: Implement Shared Server Parser Safety

**Files:**
- Modify: `supabase/functions/_shared/parser.ts`

**Interfaces:**
- Export `MAX_INPUT_BYTES`, `MAX_ROWS`, `MAX_COLUMNS`, `MAX_CELLS`, `MAX_CELL_LENGTH`, `MAX_ZIP_UNCOMPRESSED_BYTES`, and `MAX_ZIP_ENTRIES`.
- Preserve `parseImportMatrix(matrix, rowLimit)` and `parseWorkbook(data, spreadsheet)` signatures.

- [ ] **Step 1: Add constants and ZIP preflight helpers**

Define exact documented limits. Detect ZIP local-file signature `PK\x03\x04` or empty/archive signatures before parsing. Use `DataView` over the input bytes to locate the EOCD by reverse scan within the maximum comment window, validate EOCD bounds, reject multi-disk records, reject ZIP64/sentinel entry counts and sizes, validate central-directory range, iterate each fixed-size central-directory entry, reject malformed signatures or truncated records, reject ZIP64 extra-field indicators needed for sizes, count entries, and sum uncompressed sizes with overflow-safe arithmetic.

- [ ] **Step 2: Gate bytes before `spreadsheet.read`**

Reject empty input with existing error. Reject byte length over `MAX_INPUT_BYTES` before ZIP inspection and before `spreadsheet.read`. For ZIP signatures, run preflight before `spreadsheet.read`; leave non-ZIP CSV/text bytes supported.

- [ ] **Step 3: Enforce extracted matrix limits**

Validate every matrix row column count, total matrix cell count, and stringified header/cell length before header checks or row construction. Retain existing row-limit semantics, blank headers, duplicate headers, warnings, first-sheet selection, and source row numbers. Keep `rowLimit` as output slicing only after full validation.

- [ ] **Step 4: Implement exact numeric normalization**

Use one strict decimal token parser for numeric headers. Accept current optional `$`, sign, grouped comma, integer, and decimal forms. Reject malformed non-empty tokens. Convert only finite values whose canonical decimal representation round-trips to the original normalized decimal token and whose relevant scaled integer is safe; reject overflow, unsafe integers, and precision loss with actionable row/header errors. Preserve blank values and non-numeric columns.

- [ ] **Step 5: Run server GREEN**

Run the focused server parser test command. Fix only implementation defects until all server parser tests pass.

### Task 4: Implement Browser Parser Parity

**Files:**
- Modify: `src/services/importData.ts`

**Interfaces:**
- Export browser equivalents of all seven limits, retaining `MAX_IMPORT_FILE_SIZE` as an alias if existing callers require it.
- Preserve `validateImportFile`, `validateImportBytes`, `parseImportFile`, `parseImportMatrix`, and import result shape.

- [ ] **Step 1: Mirror constants and byte validation**

Use the exact server limits. Reject empty and oversized bytes before `XLSX.read`; run the same ZIP preflight logic on browser `ArrayBuffer` input before SheetJS expansion. Keep existing extension validation and CSV support.

- [ ] **Step 2: Mirror matrix and numeric validation**

Apply same row/column/cell/header/value checks and numeric token rules as server. Preserve first-sheet selection, blank header omission, duplicate rejection, blank entity warnings, row limit slicing, and idempotent row shape.

- [ ] **Step 3: Run browser GREEN**

Run the focused browser parser test command and then both focused parser suites together. Resolve parity failures without UI changes.

### Task 5: Full Verification

**Files:**
- No additional source files.

- [ ] **Step 1: Run focused RED/GREEN evidence capture**

Record the initial failing focused commands and final passing focused commands for server and browser parser tests.

- [ ] **Step 2: Run full unit tests**

Run:

```text
npm test
```

- [ ] **Step 3: Run build**

Run:

```text
npm run build
```

- [ ] **Step 4: Run Deno/Supabase checks**

Discover available commands with `deno --version` and `supabase --help`; run local function TypeScript checks or Supabase function checks if installed. Do not deploy, apply remote migrations, push, or commit. Report unavailable tools exactly.

- [ ] **Step 5: Inspect changed files**

Review changed-file list and diff/check output if Git metadata is available; otherwise inspect edits directly. Confirm no schema/UI files, secrets, remote operations, or commits were introduced.
