# Sentinel Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure Sentinel authentication, shared analyst/manager permissions, private upload retention, asynchronous CSV/XLSX ingestion, persisted investigations, and audit events without starting real agent execution.

**Architecture:** Use a typed Supabase browser client for authenticated UI reads and writes. Enforce workspace membership and roles with Postgres RLS; keep privileged invitations and server-authoritative parsing in Edge Functions. Upload originals to private Storage, use a Web Worker for preview, and use `parse-upload` for final validation and normalized row persistence.

**Tech Stack:** React 19, TypeScript, Vite, React Router 7, Supabase Auth, Supabase Postgres, Supabase Storage, Supabase Edge Functions, SheetJS, Vitest, Testing Library, and Playwright.

## Global Constraints

- Product name and internal codename: Sentinel.
- Use a new Supabase project dedicated to Sentinel; do not modify connected project `njsarrcvclpwtrtznafw`.
- Authentication is invite-only email/password.
- One shared workspace with `analyst` and `manager` roles.
- All Sentinel tables require RLS.
- Authorization data lives in `sentinel_members`, never editable user metadata.
- Browser exposes only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- Service-role credentials exist only in Edge Function secrets.
- Original files remain in private Storage bucket `sentinel-imports`.
- Initial upload maximum is `25 MB` (`26214400` bytes).
- Browser parsing is preview-only; server parsing is authoritative.
- XLSX processing buffers the file; CSV processing may stream.
- Agent execution, evidence, decision, and report persistence are excluded.
- New investigations render `Analysis not started` rather than fixture agent output.
- Run `npm run build`, `npm run test`, and `npm run test:e2e` before completion.

---

## File Map

### Create

- `.env.example` - required public Supabase environment variables.
- `supabase/config.toml` - local Edge Function configuration when Supabase CLI is available.
- `supabase/migrations/20260805_sentinel_foundation.sql` - Sentinel tables, constraints, helper functions, RLS, and Storage policies.
- `supabase/functions/_shared/cors.ts` - safe CORS headers for authenticated Edge Functions.
- `supabase/functions/_shared/auth.ts` - request authentication and workspace role helpers.
- `supabase/functions/invite-member/index.ts` - manager-only teammate invitation.
- `supabase/functions/parse-upload/index.ts` - authenticated server-authoritative parser.
- `src/lib/supabase.ts` - typed browser client and configuration guard.
- `src/lib/supabase.test.ts` - configuration guard tests.
- `src/lib/database.types.ts` - generated-schema-compatible Sentinel database types.
- `src/auth/AuthProvider.tsx` - session state and auth actions.
- `src/auth/ProtectedRoute.tsx` - signed-in route guard.
- `src/pages/SignInPage.tsx` - invite-only email/password sign-in.
- `src/services/sentinelInvestigations.ts` - investigation persistence contract.
- `src/services/sentinelUploads.ts` - Storage upload and parsing status contract.
- `src/workers/importPreview.worker.ts` - non-blocking preview validation.
- `src/workers/importPreview.ts` - Worker client and typed messages.
- `src/services/sentinelInvestigations.test.ts` - investigation service tests.
- `src/services/sentinelUploads.test.ts` - upload service tests.
- `src/auth/AuthProvider.test.tsx` - auth state tests.
- `src/pages/SignInPage.test.tsx` - sign-in behavior tests.
- `src/components/import/ImportDialog.test.tsx` - import state-machine tests.
- `src/pages/WorkspacePage.test.tsx` - role-aware member-management tests.
- `supabase/functions/parse-upload/index.test.ts` - parser normalization tests where Edge Function test runtime supports them.

### Modify

- `package.json` and `package-lock.json` - add `@supabase/supabase-js`.
- `src/main.tsx` - mount auth provider and preserve existing styling imports.
- `src/app/App.tsx` - add protected routing and sign-in route.
- `src/components/import/ImportDialog.tsx` - preview, upload, async status polling, retry, and error states.
- `src/pages/OverviewPage.tsx` - use persisted investigations and show analysis-not-started state.
- `src/pages/CasesPage.tsx` - use persisted Sentinel investigation service.
- `src/pages/CaseWorkspacePage.tsx` - load persisted investigation and import rows.
- `src/pages/WorkspacePage.tsx` - add manager-only member invitation form.
- `tests/workspace.spec.ts` - authenticated upload and permission smoke flow.
- `playwright.config.ts` - test environment variables and authenticated test setup.

## Interfaces

```ts
export type SentinelRole = "analyst" | "manager";

export interface AuthUser {
  id: string;
  email: string;
}

export interface SentinelSession {
  user: AuthUser;
  workspaceId: string;
  role: SentinelRole;
}

export type UploadStatus =
  | "created"
  | "uploading"
  | "uploaded"
  | "processing"
  | "parsed"
  | "failed";

export interface SentinelUpload {
  id: string;
  investigationId: string;
  status: UploadStatus;
  rowCount: number;
  warnings: string[];
  errorMessage: string | null;
}

export interface SentinelInvestigationService {
  list(): Promise<CaseSummary[]>;
  getById(id: string): Promise<CaseSummary | null>;
  create(input: { entity: string; ownerId: string }): Promise<CaseSummary>;
}

export interface SentinelUploadService {
  createUpload(input: {
    investigationId: string;
    file: File;
  }): Promise<SentinelUpload>;
  startParsing(uploadId: string): Promise<void>;
  getStatus(uploadId: string): Promise<SentinelUpload>;
  retryParsing(uploadId: string): Promise<void>;
  listRows(uploadId: string): Promise<ImportRow[]>;
}
```

---

## Task 1: Add Supabase Client and Environment Contract

**Files:**
- Create: `.env.example`
- Create: `src/lib/supabase.ts`
- Create: `src/lib/database.types.ts`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces `supabase`, `isSupabaseConfigured`, and typed `Database` used by auth and services.

- [ ] **Step 1: Add failing configuration tests**

Create a small configuration test that imports the guard without requiring a real project:

```ts
it("does not create a client when public Supabase environment is absent", () => {
  expect(isSupabaseConfigured).toBe(false);
  expect(supabase).toBeNull();
});
```

- [ ] **Step 2: Run configuration test**

Run: `npm run test -- src/lib/supabase.test.ts`

Expected: FAIL because client configuration module does not exist.

- [ ] **Step 3: Install typed Supabase client**

Run: `npm install @supabase/supabase-js`

- [ ] **Step 4: Implement configuration guard**

Read `import.meta.env.VITE_SUPABASE_URL` and `import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY`. Export `null` client when either value is absent so local unit tests and unconfigured development builds remain explicit rather than crashing during module import. Never add a service-role variable to `.env.example`.

Use this environment contract:

```env
VITE_SUPABASE_URL=https://your-sentinel-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

- [ ] **Step 5: Run configuration test and build**

Run: `npm run test -- src/lib/supabase.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS with no TypeScript errors.

---

## Task 2: Create Sentinel Schema, RLS, and Storage Policies

**Files:**
- Create: `supabase/migrations/20260805_sentinel_foundation.sql`
- Create: `supabase/config.toml`

**Interfaces:**
- Produces tables `sentinel_workspaces`, `sentinel_members`, `sentinel_investigations`, `sentinel_uploads`, `sentinel_import_rows`, and `sentinel_activity_events`.
- Produces private helper functions for active-member and manager checks.
- Produces private `sentinel-imports` bucket policies.

- [ ] **Step 1: Write schema assertions**

Add a SQL verification script or integration test asserting each Sentinel table exists, RLS is enabled, the upload byte check is `<= 26214400`, `sentinel_import_rows` has unique `(upload_id, source_row)`, and no public Storage policy exists for `sentinel-imports`.

- [ ] **Step 2: Run schema assertions against local Supabase when available**

Run: `supabase start`

Expected: local Supabase services start. If CLI is unavailable, record environment blocker and continue with SQL linting plus mocked integration tests; do not apply SQL to unrelated remote project.

- [ ] **Step 3: Implement migration tables and constraints**

Create all tables and constraints from the approved design. Add `unique (workspace_id, reference)` to investigations and `unique (upload_id, source_row)` to import rows. Add indexes for workspace membership, investigation ownership, upload status, and upload row lookup.

- [ ] **Step 4: Implement private authorization helpers**

Create `private.sentinel_is_active_member(uuid)` and `private.sentinel_is_manager(uuid)` as `security definer` SQL functions with fixed `search_path = public, pg_temp`. Revoke execute from `public`, grant execute to `authenticated`, and never place these functions in exposed `public` schema.

- [ ] **Step 5: Enable RLS and add policies**

Enable RLS on every Sentinel table. Add policies so active members can read workspace-scoped data, analysts can create investigations and update assigned investigations, managers can update all investigations and memberships, only parser/server code inserts import rows, and activity events cannot be updated or deleted by clients. Include SELECT policies for every UPDATE policy.

- [ ] **Step 6: Add private Storage bucket and policies**

Create `sentinel-imports` as private storage with a 25 MB file limit. Restrict object select/insert/update to active members whose workspace UUID matches first path segment. Do not grant public access. Do not grant browser delete access in first slice.

- [ ] **Step 7: Verify schema and advisors**

Run local migration verification, then inspect Supabase security advisors after applying to the new Sentinel project. Expected: no exposed Sentinel table lacks RLS and no service-role credential appears in client configuration.

---

## Task 3: Implement Auth Provider and Protected Routes

**Files:**
- Create: `src/auth/AuthProvider.tsx`
- Create: `src/auth/ProtectedRoute.tsx`
- Create: `src/pages/SignInPage.tsx`
- Create: `src/auth/AuthProvider.test.tsx`
- Create: `src/pages/SignInPage.test.tsx`
- Modify: `src/main.tsx`, `src/app/App.tsx`

**Interfaces:**
- `AuthProvider` exposes `session`, `user`, `role`, `workspaceId`, `loading`, `configurationError`, `signIn`, and `signOut`.
- `ProtectedRoute` renders children only for an authenticated active member.
- `SignInPage` exposes labeled email/password controls and invite-only copy.

- [ ] **Step 1: Write failing auth tests**

Cover loading state, missing configuration state, invalid credentials, successful sign-in, sign-out, and manager/analyst role loading from `sentinel_members`. Assert no sign-up control is rendered.

- [ ] **Step 2: Run auth tests to verify failure**

Run: `npm run test -- src/auth/AuthProvider.test.tsx src/pages/SignInPage.test.tsx`

Expected: FAIL because auth provider and sign-in page are absent.

- [ ] **Step 3: Implement auth provider**

Use Supabase `auth.getSession()` on mount and `auth.onAuthStateChange()` for updates. Query the active membership after session load. Map Supabase errors to user-facing copy without exposing raw database details. Do not call `auth.signUp`.

- [ ] **Step 4: Implement protected route and sign-in page**

Redirect unauthenticated users to `/sign-in`. Preserve intended pathname in router state. Show configuration error when environment variables are absent. Use visible focus, 44px controls, and `aria-live="polite"` for auth errors.

- [ ] **Step 5: Mount provider and route guard**

Wrap `App` with `AuthProvider`. Add `/sign-in` outside the protected shell and guard all workspace routes. Keep existing not-found behavior inside protected routes.

- [ ] **Step 6: Run auth tests and build**

Run: `npm run test -- src/auth/AuthProvider.test.tsx src/pages/SignInPage.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

---

## Task 4: Add Investigation and Upload Services

**Files:**
- Create: `src/services/sentinelInvestigations.ts`
- Create: `src/services/sentinelUploads.ts`
- Create: `src/services/sentinelInvestigations.test.ts`
- Create: `src/services/sentinelUploads.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Produces `SentinelInvestigationService` and `SentinelUploadService` from the interfaces above.
- Adds `Analysis not started` state to persisted case presentation without changing agent fixture status vocabulary.

- [ ] **Step 1: Write failing service tests**

Test query mapping, workspace scoping, create payload, file extension/size rejection, Storage path generation, upload metadata, parser invocation, status polling, retry, and import-row mapping. Use a typed fake Supabase client; do not contact a remote project from unit tests.

- [ ] **Step 2: Run service tests to verify failure**

Run: `npm run test -- src/services/sentinelInvestigations.test.ts src/services/sentinelUploads.test.ts`

Expected: FAIL because service modules are absent.

- [ ] **Step 3: Implement investigation service**

Use current authenticated `workspaceId` and `auth.uid()`. Create investigation with entity and owner. Map persisted rows to existing `CaseSummary` shape and return `null` for not-found instead of throwing on valid empty lookup.

- [ ] **Step 4: Implement upload service**

Reject extensions outside `.csv`, `.xls`, `.xlsx`, files over 25 MB, and empty files before Storage upload. Insert upload metadata, upload to the exact workspace/investigation/upload path, set `uploaded`, invoke `parse-upload`, and map status/errors. Use idempotent retry with the existing upload ID.

- [ ] **Step 5: Implement row and status mapping**

Map server `warnings` JSON to `string[]`, nullable server errors to `errorMessage`, and rows to existing `ImportRow` values. Never insert normalized rows from browser service.

- [ ] **Step 6: Run service tests**

Run: `npm run test -- src/services/sentinelInvestigations.test.ts src/services/sentinelUploads.test.ts`

Expected: PASS.

---

## Task 5: Implement Non-Blocking Preview Worker

**Files:**
- Create: `src/workers/importPreview.worker.ts`
- Create: `src/workers/importPreview.ts`
- Modify: `src/services/importData.ts`, `src/services/importData.test.ts`

**Interfaces:**
- `previewImport(file: File): Promise<{ headers: string[]; rows: ImportRow[]; warnings: string[] }>`.
- Worker messages are discriminated unions `{ type: "preview"; file: File }`, `{ type: "ready"; preview: ... }`, and `{ type: "error"; message: string }`.

- [ ] **Step 1: Add worker preview tests**

Test preview of valid CSV, missing entity header, missing numeric value header, empty file, unsupported extension, and 25 MB rejection. Assert the main thread receives preview result without invoking persisted-row writes.

- [ ] **Step 2: Run preview tests to verify failure**

Run: `npm run test -- src/services/importData.test.ts`

Expected: FAIL for new preview contract until worker adapter is implemented.

- [ ] **Step 3: Extract shared validation rules**

Keep extension, size, header, and numeric-column checks in a pure module usable by both browser preview and Edge Function tests. Browser preview may inspect only the first preview rows; it must not be the persistence source of truth.

- [ ] **Step 4: Implement Worker adapter**

Run SheetJS parsing outside React main thread. Return first five rows for preview, warnings for blank entities, and plain-language errors. Terminate Worker on success, failure, and component unmount.

- [ ] **Step 5: Run preview tests and build**

Run: `npm run test -- src/services/importData.test.ts`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

---

## Task 6: Implement Edge Functions

**Files:**
- Create: `supabase/functions/_shared/cors.ts`
- Create: `supabase/functions/_shared/auth.ts`
- Create: `supabase/functions/invite-member/index.ts`
- Create: `supabase/functions/parse-upload/index.ts`
- Create: `supabase/functions/parse-upload/index.test.ts`

**Interfaces:**
- `POST /functions/v1/invite-member` accepts `{ email: string; role: "analyst" }` and returns `{ invited: true }`.
- `POST /functions/v1/parse-upload` accepts `{ uploadId: string }` and returns `{ uploadId: string; status: "processing" | "parsed" | "failed" }`.

- [ ] **Step 1: Write parser normalization tests**

Test first-sheet selection, case-insensitive entity/company/vendor header mapping, numeric amount/value/total/debit/credit/balance/transaction/cost/price detection, blank entity warnings, no usable rows, and idempotent duplicate source rows.

- [ ] **Step 2: Run parser tests to verify failure**

Run: `npm run test -- supabase/functions/parse-upload/index.test.ts`

Expected: FAIL because parser module and shared normalization are absent.

- [ ] **Step 3: Implement shared request/auth helpers**

Require bearer token, create a user-scoped Supabase client for authorization checks, validate JSON content type, and return consistent CORS/error responses. Never log file contents, passwords, tokens, or service-role credentials.

- [ ] **Step 4: Implement manager invitation function**

Verify caller's active manager membership, validate email and fixed analyst role, call privileged Auth invitation API with service role, insert pending member, and emit `member-invited`. Return generic conflict text for existing membership without leaking account state.

- [ ] **Step 5: Implement authoritative parser function**

Verify active membership for upload workspace, transition `uploaded` to `processing`, download the private Storage object, parse first worksheet, apply shared validation, insert rows with `(upload_id, source_row)` conflict protection, update count/warnings/status, and emit completion/failure event. On any error, set `failed` and retain original object.

- [ ] **Step 6: Run Edge Function tests and local checks**

Run parser tests and local function serve/invoke checks with seeded authenticated users. Expected: analyst can parse own workspace file; cross-workspace upload returns forbidden; retry does not duplicate rows; failed parse remains retryable.

---

## Task 7: Wire Import UI, Persisted Cases, and Team Management

**Files:**
- Modify: `src/components/import/ImportDialog.tsx`
- Modify: `src/pages/OverviewPage.tsx`
- Modify: `src/pages/CasesPage.tsx`
- Modify: `src/pages/CaseWorkspacePage.tsx`
- Modify: `src/pages/WorkspacePage.tsx`
- Modify: `src/app/App.tsx`

**Interfaces:**
- Import dialog consumes `SentinelUploadService` and exposes preview, upload, processing, parsed, and failed states.
- Pages consume service interfaces, not direct Supabase calls.

- [ ] **Step 1: Write failing component tests**

Cover sign-in redirect, preview display, upload progress, processing status, parsed row preview, failed retry, manager-only invite form, analyst forbidden state, persisted case links, and analysis-not-started state.

- [ ] **Step 2: Run component tests to verify failure**

Run: `npm run test -- src/components/import/ImportDialog.test.tsx src/pages/WorkspacePage.test.tsx`

Expected: FAIL until UI wiring is implemented.

- [ ] **Step 3: Implement import dialog state machine**

Use `created`, `uploading`, `uploaded`, `processing`, `parsed`, and `failed` states. Start Worker preview on file selection, upload only after confirmation, poll status while mounted, stop polling on terminal state, and retry the same upload ID after failure. Announce transitions through existing ToastRegion.

- [ ] **Step 4: Replace production case reads**

Overview and Cases load Sentinel investigations. Case workspace loads persisted investigation and import rows. Keep fixture pipeline/evidence/decision/report components behind explicit development/demo boundaries. Render `Analysis not started` for persisted cases.

- [ ] **Step 5: Add manager invitation UI**

Workspace page shows member list to active managers, hides invite controls for analysts, validates email, calls `invite-member`, and announces success/failure. Do not expose invite function credentials.

- [ ] **Step 6: Run component tests**

Run: `npm run test -- src/components/import/ImportDialog.test.tsx src/pages/WorkspacePage.test.tsx src/app/App.test.tsx`

Expected: PASS.

---

## Task 8: Authenticated End-to-End and Security Verification

**Files:**
- Modify: `tests/workspace.spec.ts`
- Modify: `playwright.config.ts`
- Create: `tests/auth.setup.ts`
- Create: `tests/fixtures/sentinel-upload.csv`

**Interfaces:**
- Test manager and analyst credentials come from test-only environment variables, never committed files.
- Auth setup stores Playwright session state for each role.

- [ ] **Step 1: Add authenticated E2E setup**

Create manager and analyst storage states against a dedicated test Sentinel project. If test credentials are absent, fail with a clear setup message rather than silently bypassing auth.

- [ ] **Step 2: Add upload flow test**

Assert analyst sign-in, create investigation, upload valid CSV, see processing, see parsed status, reload, and see persisted rows. Assert original file is not publicly fetchable.

- [ ] **Step 3: Add permission tests**

Assert analyst cannot access manager member invitation action and cannot modify another analyst's assigned case. Assert manager can view invitation UI.

- [ ] **Step 4: Add invalid and retry tests**

Upload unsupported extension and missing numeric header; assert readable error. Exercise parser failure fixture, retry, and terminal success without duplicate rows.

- [ ] **Step 5: Run complete verification**

Run:

```text
npm run build
npm run test
npm run test:e2e
```

Expected: all commands pass with no service-role key in browser bundle and no RLS/security advisor findings for Sentinel objects.

---

## Plan Self-Review

### Coverage

- New project isolation: Global Constraints, Task 2.
- Invite-only auth: Tasks 1, 3, 6, 8.
- Analyst/manager permissions: Tasks 2, 3, 6, 7, 8.
- Private original file retention: Tasks 2, 4, 6, 8.
- Async hybrid ingestion: Tasks 4, 5, 6, 7, 8.
- Server-authoritative rows: Tasks 2, 4, 6.
- Retry and idempotency: Tasks 4, 6, 7, 8.
- Immutable audit events: Tasks 2 and 6.
- Fixture boundary: Task 7.
- Accessibility and responsive states: Tasks 3 and 7.

### Placeholder Scan

No `TBD`, `TODO`, or unowned implementation requirement remains. CLI-dependent checks name a concrete fallback when local Supabase is unavailable.

### Type Consistency

`SentinelRole`, `SentinelSession`, `UploadStatus`, `SentinelUpload`, `SentinelInvestigationService`, and `SentinelUploadService` are defined once in this plan and consumed consistently by auth, services, UI, and tests.
