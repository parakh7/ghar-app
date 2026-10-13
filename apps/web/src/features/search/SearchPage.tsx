import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useDebouncedValue } from "./useDebouncedValue";
import { useSearch } from "./useSearch";

export function SearchPage() {
  const { household } = useActiveHousehold();
  const [searchParams] = useSearchParams();
  const [input, setInput] = useState(searchParams.get("q") ?? "");
  const debounced = useDebouncedValue(input, 300);
  const results = useSearch(household?.id, debounced).data;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Search</h1></header>
      <input
        type="search" value={input} onChange={(e) => setInput(e.target.value)}
        placeholder="Search househelps, bills, checklist, members" aria-label="Search"
        style={{ width: "100%", height: "var(--touch)", padding: "0 var(--space-3)", borderRadius: "var(--radius-sm)", border: "1.5px solid var(--line-strong)", marginBottom: "var(--space-4)" }}
      />
      {results?.househelps && (
        <>
          <h2 className="section-title">Househelps</h2>
          <div className="list">
            {results.househelps.map((h) => (
              <Link key={h.id} to={`/househelps/${h.id}`} className="list__item"><span className="list__label">{h.name}</span></Link>
            ))}
          </div>
        </>
      )}
      {results?.bills && (
        <>
          <h2 className="section-title">Bills</h2>
          <div className="list">
            {results.bills.map((b) => (
              <Link key={b.id} to={`/bills/${b.id}`} className="list__item">
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{b.name}</span>
                  {b.provider && <span className="list__meta">{b.provider}</span>}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
      {results?.checklistTasks && (
        <>
          <h2 className="section-title">Checklist</h2>
          <div className="list">
            {results.checklistTasks.map((t) => (
              <Link key={t.id} to={`/checklist/${t.id}`} className="list__item"><span className="list__label">{t.name}</span></Link>
            ))}
          </div>
        </>
      )}
      {results?.members && (
        <>
          <h2 className="section-title">Members</h2>
          <div className="list">
            {results.members.map((m) => (
              <div key={m.userId} className="list__item">
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{m.name}</span>
                  <span className="list__meta">{m.email}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
