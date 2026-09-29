const KEY = "ghar.activeHousehold";

/** Remembers which household the user last looked at (UI preference only — never used for authorization). */
export function getActiveHouseholdId(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function setActiveHouseholdId(id: string): void {
  try { localStorage.setItem(KEY, id); } catch { /* private mode */ }
}
