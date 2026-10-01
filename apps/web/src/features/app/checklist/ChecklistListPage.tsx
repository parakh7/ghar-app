import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import type { ChecklistTaskDTO } from "@household/shared";
import { Button } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { useActiveHousehold } from "../useActiveHousehold";
import { useHousehold } from "../members/useMembers";
import { useCategories } from "../househelps/useHousehelps";
import { formatFrequency } from "./frequency";
import { useChecklistTasks } from "./useChecklist";

function TaskRow({ t }: { t: ChecklistTaskDTO }) {
  return (
    <Link to={`/checklist/${t.id}`} className="list__item">
      <span className="list__text">
        <span className="list__label" style={{ display: "block" }}>{t.name}{t.archivedAt && " (archived)"}</span>
        <span className="list__meta">{formatFrequency(t)}{t.priority === "HIGH" && " · High priority"}</span>
      </span>
    </Link>
  );
}

export function ChecklistListPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const tasksQuery = useChecklistTasks(householdId, showArchived);
  const categoriesQuery = useCategories(householdId);
  const canManage = householdQuery.data?.permissions.includes("checklists.manage") ?? false;

  if (!householdId) return null;

  const tasks = tasksQuery.data ?? [];
  const activeCategories = (categoriesQuery.data ?? []).filter((c) => c.isActive);
  const activeCategoryIds = new Set(activeCategories.map((c) => c.id));
  const uncategorized = tasks.filter((t) => !t.categoryId || !activeCategoryIds.has(t.categoryId));

  return (
    <>
      <header className="page-head"><h1 className="page-title">Checklist</h1></header>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <button type="button" className="chip" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Showing archived" : "Show archived"}
        </button>
        <Link to="/checklist/today" className="list__label">Today's checklist</Link>
      </div>

      {tasks.length === 0 && (
        <div className="card">
          <EmptyState
            icon={<Plus size={22} />} title="No tasks yet" text="Add a daily, weekly or monthly task to start tracking."
            action={canManage ? <Button onClick={() => navigate("/checklist/new")}>Add task</Button> : undefined}
          />
        </div>
      )}

      {activeCategories.map((c) => {
        const inCategory = tasks.filter((t) => t.categoryId === c.id);
        if (inCategory.length === 0) return null;
        return (
          <div key={c.id}>
            <h2 className="section-title">{c.name}</h2>
            <div className="list">{inCategory.map((t) => <TaskRow key={t.id} t={t} />)}</div>
          </div>
        );
      })}

      {uncategorized.length > 0 && (
        <div>
          <h2 className="section-title">Uncategorized</h2>
          <div className="list">{uncategorized.map((t) => <TaskRow key={t.id} t={t} />)}</div>
        </div>
      )}

      {canManage && tasks.length > 0 && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <Button variant="secondary" block icon={<Plus size={20} aria-hidden />} onClick={() => navigate("/checklist/new")}>Add task</Button>
        </div>
      )}
    </>
  );
}
