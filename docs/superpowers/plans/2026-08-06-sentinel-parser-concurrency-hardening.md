# Sentinel Parser Concurrency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make upload parsing lease-safe by moving row replacement, terminal upload state, and parse events into service-role-only transaction functions, while enforcing parser resource and numeric validation limits.

**Architecture:** The Edge Function claims through existing conditional REST update, then passes the exact lease timestamp into one typed `admin.rpc` finalization or failure call. PostgreSQL locks and validates the processing upload before changing rows, upload state, and events in one transaction. Parser extraction remains pure and validates headers, dimensions, cell lengths, and numeric columns before RPC persistence.

**Tech Stack:** Supabase PostgreSQL migration, Deno-compatible TypeScript Edge Function modules, Vitest typed fakes, XLSX parser.

## Global Constraints

- Existing parsed row JSON shape remains `{ sourceRow, entity, values }`.
- Transaction functions are `SECURITY INVOKER`, fixed `search_path = public, pg_temp`, and executable only by `service_role`.
- No UI changes, remote apply/deploy/push, secrets, or file-content logging.
- Fresh, stale, and null processing lease behavior remains; future timestamps are not fresh.
- Parser limits: max rows `100000`, max columns `256`, max cells `2000000`, max cell/header length `10000`.

---

### Task 1: Add Red Tests For Transaction RPC Contract

**Files:**
- Modify: `supabase/functions/parse-upload/processing.test.ts`
- Modify: `supabase/functions/parse-upload/route.test.ts`

**Interfaces:**
- Test typed `SupabaseClientLike.rpc(functionName, payload)` responses for lease mismatch, row replacement, failure cleanup, event identity, and reconciliation.
- Test route `handleRoute` for CORS and bearer/method rejection using existing auth and request mocks.

- [ ] **Step 1: Write failing typed-RPC fake tests**

Add an RPC fake whose `rpc` method records function name/payload and returns configured `{ data, error }`. Assert completion sends `upload_id`, workspace/investigation IDs, exact `lease_started_at`, `rows` as `{ sourceRow, entity, values }[]`, `warnings`, and `actor_id`. Assert failure sends same lease and error text. Assert lease mismatch maps to `ProcessingLeaseLostError`; generic RPC errors remain generic state errors. Assert no `from("sentinel_import_rows")` delete/upsert/update calls occur.

Add contract tests for the typed fake behavior: mismatch does not replace rows, successful completion replaces all prior rows, simulated insert failure leaves no rows, completion metadata contains `upload_id`, and reconcile returns false when identity exists and true when it inserts.

- [ ] **Step 2: Add failing route coverage**

Import `handleRoute` and assert OPTIONS succeeds with CORS headers, disallowed origin returns the existing CORS rejection, missing and malformed bearer requests return authorization errors without admin calls, and non-POST requests return 405. Keep assertions independent of parser/storage mocks.

- [ ] **Step 3: Run focused tests and verify RED**

Run `npm test -- --run supabase/functions/parse-upload/processing.test.ts supabase/functions/parse-upload/route.test.ts`.

Expected: FAIL because typed RPC helpers and route handling changes do not exist yet.

### Task 2: Add Failing Parser Limit And Numeric Tests

**Files:**
- Modify: `supabase/functions/parse-upload/index.test.ts`

**Interfaces:**
- Exercise `parseImportMatrix` with documented exported parser limits and actionable errors.

- [ ] **Step 1: Add limit tests**

Add tests for 100001 usable rows, 257 columns, more than 2000000 matrix cells, a 10001-character header, and a 10001-character cell. Each must throw an error naming the violated limit and location where applicable.

- [ ] **Step 2: Add malformed numeric tests**

Add numeric-header cases that accept existing `$1,200`, `1,200`, negative values, and numeric values, while rejecting non-empty malformed tokens such as `12abc`, `$1,2x0`, and `1.2.3` with row and normalized header in the error.

- [ ] **Step 3: Run parser tests and verify RED**

Run `npm test -- --run supabase/functions/parse-upload/index.test.ts`.

Expected: FAIL for new limit and malformed numeric assertions.

### Task 3: Implement Parser Validation

**Files:**
- Modify: `supabase/functions/_shared/parser.ts`

**Interfaces:**
- Export documented constants `MAX_ROWS`, `MAX_COLUMNS`, `MAX_CELLS`, and `MAX_CELL_LENGTH`.
- Preserve `ParsedImportRow` and existing blank-header output behavior.

- [ ] **Step 1: Add constants and matrix dimension validation**

Define the four limits with exact values and comments documenting enforcement after matrix extraction and before row persistence. Validate matrix column count, total matrix cell count, and header/cell string lengths before constructing rows. Report actionable errors with limit, actual context, and row/header location.

- [ ] **Step 2: Tighten numeric token parsing**

Use one strict token predicate for numeric headers. Preserve supported numeric strings and currency/commas only when the complete trimmed token matches a valid optional sign, digits, grouped commas or decimal digits, optional currency marker format already accepted. For each non-empty value in a numeric-header column, throw `Invalid numeric value at row N, header "header"` when token is malformed instead of returning text. Keep non-numeric columns as strings.

- [ ] **Step 3: Enforce row limit after extraction**

Retain blank-entity warnings and source row numbering, then reject a result exceeding `MAX_ROWS` before callers can persist rows. Ensure headers are normalized once, duplicate non-empty normalized headers remain rejected, and blank headers remain omitted consistently from `headers` and `values`.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run `npm test -- --run supabase/functions/parse-upload/index.test.ts`.

Expected: PASS, including legacy currency/comma behavior.

### Task 4: Implement Transaction Functions Migration

**Files:**
- Modify: `supabase/migrations/20260806134251_sentinel_parser_transaction_functions.sql`

**Interfaces:**
- Create `public.sentinel_finalize_upload(uuid, uuid, uuid, timestamptz, jsonb, jsonb, uuid) returns jsonb`.
- Create `public.sentinel_fail_upload(uuid, uuid, uuid, timestamptz, uuid, text) returns jsonb`.
- Create `public.sentinel_reconcile_parse_event(uuid, uuid, uuid, uuid, integer, integer) returns boolean`.

- [ ] **Step 1: Implement lease-locked finalization**

Define a `SECURITY INVOKER` PL/pgSQL function with `set search_path = public, pg_temp`. Select the upload `FOR UPDATE` matching all IDs, status `processing`, and exact lease timestamp; raise a stable lease-lost exception when absent. Delete existing rows for upload, insert every JSON row using `sourceRow`, `entity`, and `values`, update parsed state/count/warnings/processed timestamp, insert parse-completed event with `metadata` containing `upload_id`, row count, and warning count, and return claimed state JSON. All statements run in one function transaction.

- [ ] **Step 2: Implement lease-locked failure**

Lock the same lease row, raise lease-lost when absent, delete partial rows scoped by upload, update failed/error/processed timestamp, insert parse-failed event with `upload_id`, and return current failed state JSON. Keep error text server-controlled by caller input and avoid unscoped deletes.

- [ ] **Step 3: Implement idempotent event reconciliation**

For a parsed upload matching all IDs, insert parse-completed only when no existing parse-completed event has `metadata ->> 'upload_id'` equal to upload ID. Include actor, row count, warning count, and upload ID. Return whether an event was inserted; return false for already-identified event. Do not create events for non-parsed or mismatched uploads.

- [ ] **Step 4: Lock down privileges**

Revoke execute from `public`, `anon`, and `authenticated`; grant execute only to `service_role` for all exact signatures. Do not use `SECURITY DEFINER`.

- [ ] **Step 5: Run SQL static checks**

Run `rg -n "sentinel_(finalize|fail|reconcile)_upload|security (definer|invoker)|grant execute|revoke" supabase/migrations/20260806134251_sentinel_parser_transaction_functions.sql` and inspect every function signature, search path, lock predicate, metadata upload ID, and grant.

### Task 5: Replace REST Persistence With Typed RPC

**Files:**
- Modify: `supabase/functions/parse-upload/processing.ts`
- Modify: `supabase/functions/parse-upload/index.ts`
- Modify: `supabase/functions/parse-upload/processing.test.ts`
- Modify: `supabase/functions/parse-upload/route.test.ts`

**Interfaces:**
- `completeParse` invokes `admin.rpc("sentinel_finalize_upload", payload)` and returns parsed state.
- `markFailed` invokes `admin.rpc("sentinel_fail_upload", payload)` and returns failed state.
- Parsed short-circuit invokes `admin.rpc("sentinel_reconcile_parse_event", payload)` when event identity is missing or reconciliation is required.

- [ ] **Step 1: Implement typed RPC helpers**

Add exact RPC payload types and a typed `rpc` requirement to `SupabaseClientLike`. Convert RPC lease-lost errors using a stable code/message marker into `ProcessingLeaseLostError`. Convert all other RPC failures into truthful generic parser-state errors. Pass `lease_started_at` from the claim unchanged; do not regenerate or infer it.

- [ ] **Step 2: Remove separate row persistence and cleanup**

Delete `insertRows`, `deletePartialRowsIfOwned`, and related lease checks from route flow. After parsing and deduplication, call only `completeParse` with rows and warnings. On parser/download/RPC failure, call only `markFailed`; never call browser/server REST row delete/upsert.

- [ ] **Step 3: Preserve concurrency response semantics**

Keep future processing timestamps non-fresh by requiring `startedAt <= now`. When claim-lost latest state is failed, return 422 failed rather than 202 processing; return parsed state and reconcile event when parsed. If lease is lost during completion/failure, read current state and return it without falsely marking failed. RPC failure returns generic 500.

- [ ] **Step 4: Include upload identity in every parse event**

Keep `upload_id` in parse-started metadata and ensure completion/failure/reconciliation RPC payloads produce it in metadata. Avoid logging row contents, file bytes, secrets, or bearer tokens.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run `npm test -- --run supabase/functions/parse-upload/processing.test.ts supabase/functions/parse-upload/route.test.ts`.

Expected: PASS, with no direct import-row REST writes/deletes in route tests.

### Task 6: Full Verification

**Files:**
- No additional source files.

- [ ] **Step 1: Run full unit suite**

Run `npm test`.

- [ ] **Step 2: Run TypeScript/build verification**

Run `npm run build`.

- [ ] **Step 3: Run Deno-compatible checks**

Run available local Supabase/Deno checks for `supabase/functions/parse-upload` and TypeScript diagnostics; if Deno or Supabase CLI is unavailable, record exact command and environment limitation without substituting remote execution.

- [ ] **Step 4: Review diff and security surface**

Run `git diff --check` only if Git metadata exists; otherwise inspect changed files directly. Confirm no secrets, file contents, UI files, deploy commands, remote migration application, or push operations were performed.
