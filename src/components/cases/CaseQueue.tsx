import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { formatRelative } from "../../lib/datetime";
import { CASE_STAGE_LABELS } from "../../domain/caseStages";
import type { CaseStage, CaseSummary, RiskLevel } from "../../domain/types";
import { StatusBadge } from "../ui/StatusBadge";

interface CaseQueueProps {
  cases: CaseSummary[];
}

type SortKey = "entity" | "owner" | "ageDays";
type SortDirection = "asc" | "desc";

const riskLabels: Record<RiskLevel, string> = { low: "Low risk", medium: "Medium risk", high: "High risk", "not-assessed": "Not assessed" };

function riskTone(risk: RiskLevel) {
  return risk === "high" ? "risk" as const : risk === "low" ? "confirm" as const : risk === "not-assessed" ? "neutral" as const : "warning" as const;
}

export function CaseQueue({ cases }: CaseQueueProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [sortKey, setSortKey] = useState<SortKey>((searchParams.get("sort") as SortKey) || "ageDays");
  const [sortDirection, setSortDirection] = useState<SortDirection>(searchParams.get("direction") === "desc" ? "desc" : "asc");
  const query = searchParams.get("query") ?? "";
  const risk = searchParams.get("risk") ?? "all";
  const stage = searchParams.get("stage") ?? "all";
  const owner = searchParams.get("owner") ?? "all";

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);
    setSearchParams(next);
  };

  const handleSort = (key: SortKey) => {
    const direction = sortKey === key && sortDirection === "asc" ? "desc" : "asc";
    setSortKey(key);
    setSortDirection(direction);
    const next = new URLSearchParams(searchParams);
    next.set("sort", key);
    next.set("direction", direction);
    setSearchParams(next);
  };

  const owners = [...new Set(cases.map((item) => item.owner))];
  const filteredCases = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return cases
      .filter((item) => !normalizedQuery || `${item.id} ${item.entity} ${item.owner}`.toLowerCase().includes(normalizedQuery))
      .filter((item) => risk === "all" || item.risk === risk)
      .filter((item) => stage === "all" || item.stageId === stage)
      .filter((item) => owner === "all" || item.owner === owner)
      .sort((a, b) => {
        const left = a[sortKey];
        const right = b[sortKey];
        const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
        return sortDirection === "asc" ? comparison : -comparison;
      });
  }, [cases, owner, query, risk, sortDirection, sortKey, stage]);

  return (
    <section className="case-queue" aria-labelledby="case-queue-title">
      <div className="queue-toolbar">
        <div className="queue-search-field">
          <label htmlFor="case-search">Search cases</label>
          <input id="case-search" type="search" value={query} onChange={(event) => updateParam("query", event.target.value)} placeholder="Entity, case ID, or owner" />
        </div>
        <div className="queue-filters">
          <div className="filter-field"><label htmlFor="risk-filter">Risk</label><select id="risk-filter" value={risk} onChange={(event) => updateParam("risk", event.target.value)}><option value="all">All risk levels</option>{(Object.keys(riskLabels) as RiskLevel[]).map((level) => <option value={level} key={level}>{riskLabels[level]}</option>)}</select></div>
          <div className="filter-field"><label htmlFor="stage-filter">Stage</label><select id="stage-filter" value={stage} onChange={(event) => updateParam("stage", event.target.value)}><option value="all">All stages</option>{(Object.keys(CASE_STAGE_LABELS) as CaseStage[]).map((value) => <option value={value} key={value}>{CASE_STAGE_LABELS[value]}</option>)}</select></div>
          <div className="filter-field"><label htmlFor="owner-filter">Owner</label><select id="owner-filter" value={owner} onChange={(event) => updateParam("owner", event.target.value)}><option value="all">All owners</option>{owners.map((item) => <option value={item} key={item}>{item}</option>)}</select></div>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <caption id="case-queue-title" className="sr-only">Investigation case queue</caption>
          <thead><tr>
            <th scope="col"><button type="button" className="table-sort" aria-label="Sort entity" onClick={() => handleSort("entity")}>Case / entity <span aria-hidden="true">{sortKey === "entity" ? sortDirection === "asc" ? "^" : "v" : ""}</span></button></th>
            <th scope="col"><button type="button" className="table-sort" aria-label="Sort owner" onClick={() => handleSort("owner")}>Owner <span aria-hidden="true">{sortKey === "owner" ? sortDirection === "asc" ? "^" : "v" : ""}</span></button></th>
            <th scope="col">Stage</th>
            <th scope="col">Risk</th>
            <th scope="col"><button type="button" className="table-sort" aria-label="Sort age" onClick={() => handleSort("ageDays")}>Age <span aria-hidden="true">{sortKey === "ageDays" ? sortDirection === "asc" ? "^" : "v" : ""}</span></button></th>
            <th scope="col">Last activity</th>
          </tr></thead>
          <tbody>
            {filteredCases.map((item) => (
              <tr key={item.id}>
                <th scope="row"><Link className="table-primary-link" to={`/cases/${item.id}/summary`}><span className="numeric table-case-id">{item.id}</span><strong>{item.entity}</strong></Link></th>
                <td>{item.owner}</td>
                <td>{CASE_STAGE_LABELS[item.stageId]}</td>
                <td><StatusBadge status={item.risk} label={riskLabels[item.risk]} tone={riskTone(item.risk)} /></td>
                <td className="numeric">{item.ageDays}d</td>
                <td>{formatRelative(item.lastActivity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredCases.length === 0 && <div className="table-empty">No cases match current filters. Clear one filter to widen queue.</div>}
      </div>
    </section>
  );
}
