-- The findings read embeds evidence through the workspace-scoped relationship
-- (sentinel_evidence_workspace_finding_fkey), because the plain finding_id FK alone is
-- ambiguous to PostgREST. The existing index covers finding_id on its own, which does not
-- serve a lookup on (workspace_id, finding_id), so give the relationship the query
-- actually uses a covering index.
create index if not exists sentinel_evidence_workspace_finding_idx
  on public.sentinel_evidence (workspace_id, finding_id);
