import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useHousehelps } from "./useHousehelps";

export function HousehelpsListPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const househelpsQuery = useHousehelps(householdId, showArchived);
  const canManage = householdQuery.data?.permissions.includes("househelps.manage") ?? false;

  if (!householdId) return null;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Househelps</h1></header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <button type="button" className="chip" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
        {canManage && <Link to="/househelps/categories" className="list__label">Manage categories</Link>}
      </div>

      {househelpsQuery.data?.length === 0 && (
        <div className="card">
          <EmptyState
            icon={<Plus size={22} />} title="No househelps yet" text="Add your first househelp to start tracking attendance and salary."
            action={canManage ? <Button onClick={() => navigate("/househelps/new")}>Add househelp</Button> : undefined}
          />
        </div>
      )}

      <div className="list">
        {househelpsQuery.data?.map((h) => (
          <Link key={h.id} to={`/househelps/${h.id}`} className="list__item">
            <span className="list__text">
              <span className="list__label" style={{ display: "block" }}>{h.name}{h.archivedAt && " (archived)"}</span>
              <span className="list__meta">{h.roleTitle ?? "Househelp"}{h.status === "INACTIVE" && " · Inactive"}</span>
            </span>
          </Link>
        ))}
      </div>

      {canManage && (househelpsQuery.data?.length ?? 0) > 0 && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <Button variant="secondary" block icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/househelps/new")}>
            Add househelp
          </Button>
        </div>
      )}
    </>
  );
}
