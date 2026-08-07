# Sentinel Storage Write Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict browser writes to sentinel-imports objects owned by authenticated uploader and still in browser-upload staging.

**Architecture:** Add private security-definer authorization helper validating full workspace/investigation/upload path against `sentinel_uploads`. Recreate only INSERT and UPDATE Storage policies with helper while retaining private-bucket and active-member checks; extend existing SQL verifier to lock down helper metadata and exact policy predicates.

**Tech Stack:** PostgreSQL, Supabase Storage RLS, Supabase CLI, Vitest.

## Global Constraints

- Bucket remains private and named `sentinel-imports`.
- Browser writes remain limited to authenticated users and statuses `created` or `uploading`.
- No Storage DELETE, ALL, public, anonymous, or broad policy is introduced.
- No remote migration push or remote schema change.
- Existing `public.rls_auto_enable()` revoke behavior remains unchanged when function exists.

---

### Task 1: Extend SQL Verification

**Files:**
- Modify: `supabase/verify_sentinel_foundation.sql`

**Interfaces:**
- Verifies `private.sentinel_can_write_import_object(text)` metadata, ACL, path/owner/status body, and exact INSERT/UPDATE policy predicates.

- [ ] **Step 1: Add failing helper and policy assertions**
- [ ] **Step 2: Run local verifier against pre-change schema and confirm missing-helper or policy failure**

### Task 2: Add Storage Write Authorization Migration

**Files:**
- Modify: `supabase/migrations/20260806052243_sentinel_storage_write_scope.sql`

**Interfaces:**
- Produces `private.sentinel_can_write_import_object(object_name text)`.
- Replaces named sentinel-imports INSERT and UPDATE policies.

- [ ] **Step 1: Define fixed-search-path security-definer helper with guarded path validation**
- [ ] **Step 2: Revoke public execute and grant authenticated/service_role execute**
- [ ] **Step 3: Recreate INSERT and UPDATE policies with exact owner/status-bound helper checks**

### Task 3: Make Existing Grant Revoke Reset-Safe

**Files:**
- Modify: `supabase/migrations/20260806051251_sentinel_harden_project_function_grants.sql`

**Interfaces:**
- Keeps existing revoke when `public.rls_auto_enable()` exists and skips it when absent during reset.

- [ ] **Step 1: Wrap revoke in an existence-guarded DO block**
- [ ] **Step 2: Confirm generated SQL remains parseable**

### Task 4: Verify Locally

**Files:**
- No additional files.

- [ ] **Step 1: Parse migrations and verifier with local PostgreSQL tooling or Supabase CLI**
- [ ] **Step 2: Run `npm test`**
- [ ] **Step 3: Review changed files and report any unavailable integration checks**
