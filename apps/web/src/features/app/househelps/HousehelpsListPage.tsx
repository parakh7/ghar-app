import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import type { HousehelpDTO } from "@household/shared";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories, useHousehelps } from "./useHousehelps";

function HousehelpRow({ h }: { h: HousehelpDTO }) {
  return (
    <Link to={`/househelps/${h.id}`} className="list__item">
      <span className="list__text">
        <span className="list__label" style={{ display: "block" }}>{h.name}{h.archivedAt && " (archived)"}</span>
        <span className="list__meta">{h.roleTitle ?? "Househelp"}{h.status === "INACTIVE" && " · Inactive"}</span>
      </span>
    </Link>
  );
}

export function HousehelpsListPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const househelpsQuery = useHousehelps(householdId, showArchived);
  const categoriesQuery = useCategories(householdId);
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;
  const canManageCategories = householdQuery.data?.permissions.includes("categories.manage") ?? false;

  if (!householdId) return null;

  const househelps = househelpsQuery.data ?? [];
  const activeCategories = (categoriesQuery.data ?? []).filter((c) => c.isActive);
  const activeCategoryIds = new Set(activeCategories.map((c) => c.id));
  const uncategorized = househelps.filter((h) => !h.categoryIds.some((id) => activeCategoryIds.has(id)));

  return (
    <>
      <header className="page-head"><h1 className="page-title">Househelps</h1></header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <button type="button" className="chip" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
        {canManageCategories && <Link to="/househelps/categories" className="list__label">Manage categories</Link>}
      </div>

      {househelps.length === 0 && (
        <div className="card">
          <EmptyState
            icon={<Plus size={22} />} title="No househelps yet" text="Add your first househelp to start tracking attendance and salary."
            action={canManage ? <Button onClick={() => navigate("/househelps/new")}>Add househelp</Button> : undefined}
          />
        </div>
      )}

      {activeCategories.map((c) => {
        const inCategory = househelps.filter((h) => h.categoryIds.includes(c.id));
        if (inCategory.length === 0) return null;
        return (
          <div key={c.id}>
            <h2 className="section-title">{c.name}</h2>
            <div className="list">
              {inCategory.map((h) => <HousehelpRow key={h.id} h={h} />)}
            </div>
          </div>
        );
      })}

      {uncategorized.length > 0 && (
        <div>
          <h2 className="section-title">Uncategorized</h2>
          <div className="list">
            {uncategorized.map((h) => <HousehelpRow key={h.id} h={h} />)}
          </div>
        </div>
      )}

      {canManage && househelps.length > 0 && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <Button variant="secondary" block icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/househelps/new")}>
            Add househelp
          </Button>
        </div>
      )}
    </>
  );
}
