import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import type { BillDTO } from "@household/shared";
import { formatINR } from "@household/shared";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { formatBillFrequency } from "./billFrequency";
import { STATUS_LABEL, toneOf } from "./statusTone";
import { useBillCategories, useBills } from "./useBills";

function BillRow({ b }: { b: BillDTO }) {
  return (
    <Link to={`/bills/${b.id}`} className="list__item">
      <span className="list__text">
        <span className="list__label" style={{ display: "block" }}>{b.name}</span>
        <span className="list__meta">{b.amountPaise != null ? formatINR(b.amountPaise) : "Variable amount"} · {formatBillFrequency(b)}</span>
      </span>
      <span className={`badge badge--${toneOf(b.status)}`}>{STATUS_LABEL[b.status]}</span>
    </Link>
  );
}

export function BillsListPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const billsQuery = useBills(householdId, showArchived);
  const categoriesQuery = useBillCategories(householdId);
  const canManage = householdQuery.data?.permissions.includes("bills.manage") ?? false;
  const canManageCategories = householdQuery.data?.permissions.includes("bills.manage") ?? false;

  if (!householdId) return null;

  const bills = billsQuery.data ?? [];
  const activeCategories = (categoriesQuery.data ?? []).filter((c) => c.isActive);
  const activeCategoryIds = new Set(activeCategories.map((c) => c.id));
  const uncategorized = bills.filter((b) => !b.categoryId || !activeCategoryIds.has(b.categoryId));

  return (
    <>
      <header className="page-head"><h1 className="page-title">Bills</h1></header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <button type="button" className="chip" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
        {canManageCategories && <Link to="/bills/categories" className="list__label">Manage categories</Link>}
      </div>

      {bills.length === 0 && (
        <div className="card">
          <EmptyState
            icon={<Plus size={22} />} title="No bills yet" text="Add a bill to start tracking its due date and amount."
            action={canManage ? <Button onClick={() => navigate("/bills/new")}>Add bill</Button> : undefined}
          />
        </div>
      )}

      {activeCategories.map((c) => {
        const inCategory = bills.filter((b) => b.categoryId === c.id);
        if (inCategory.length === 0) return null;
        return (
          <div key={c.id}>
            <h2 className="section-title">{c.name}</h2>
            <div className="list">{inCategory.map((b) => <BillRow key={b.id} b={b} />)}</div>
          </div>
        );
      })}

      {uncategorized.length > 0 && (
        <div>
          <h2 className="section-title">Uncategorized</h2>
          <div className="list">{uncategorized.map((b) => <BillRow key={b.id} b={b} />)}</div>
        </div>
      )}

      {canManage && bills.length > 0 && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <Button variant="secondary" block icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/bills/new")}>Add bill</Button>
        </div>
      )}
    </>
  );
}
