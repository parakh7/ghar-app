import type { Permission, SearchResultsDTO } from "@household/shared";
import { listBills } from "./bill.service.js";
import { listChecklistTasks } from "./checklist-task.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";
import { listHousehelps } from "./househelp.service.js";
import { listMembers } from "./member.service.js";

type AuthedMembership = Membership & { permissions: Set<Permission> };

const RESULT_LIMIT = 10;

export async function search(deps: Deps, membership: AuthedMembership, query: string): Promise<SearchResultsDTO> {
  const q = query.trim().toLowerCase();
  const results: SearchResultsDTO = {};

  if (membership.permissions.has("househelps.view")) {
    const matched = q ? (await listHousehelps(deps.db, membership.householdId, false)).filter((h) => h.name.toLowerCase().includes(q)) : [];
    results.househelps = matched.slice(0, RESULT_LIMIT).map((h) => ({ id: h.id, name: h.name }));
  }

  if (membership.permissions.has("bills.view")) {
    const matched = q
      ? (await listBills(deps, membership, {})).filter((b) => b.name.toLowerCase().includes(q) || (b.provider?.toLowerCase().includes(q) ?? false))
      : [];
    results.bills = matched.slice(0, RESULT_LIMIT).map((b) => ({ id: b.id, name: b.name, provider: b.provider }));
  }

  if (membership.permissions.has("checklists.view")) {
    const matched = q ? (await listChecklistTasks(deps.db, membership.householdId, false)).filter((t) => t.name.toLowerCase().includes(q)) : [];
    results.checklistTasks = matched.slice(0, RESULT_LIMIT).map((t) => ({ id: t.id, name: t.name }));
  }

  if (membership.permissions.has("members.view")) {
    const matched = q
      ? (await listMembers(deps.db, membership.householdId)).filter((m) =>
          m.name.toLowerCase().includes(q) || (m.displayName?.toLowerCase().includes(q) ?? false) || m.email.toLowerCase().includes(q))
      : [];
    results.members = matched.slice(0, RESULT_LIMIT).map((m) => ({ userId: m.userId, name: m.name, email: m.email }));
  }

  return results;
}
