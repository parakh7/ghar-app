import { useCallback, useState } from "react";
import type { HouseholdSummaryDTO } from "@household/shared";
import { getActiveHouseholdId, setActiveHouseholdId } from "../../lib/active-household";
import { useSession } from "../auth/session";

/** The household being viewed. Only chooses among households the server says the user belongs to. */
export function useActiveHousehold(): { household: HouseholdSummaryDTO | null; households: HouseholdSummaryDTO[]; switchTo: (id: string) => void } {
  const { data } = useSession();
  const households = data?.households ?? [];
  const [preferred, setPreferred] = useState(getActiveHouseholdId);
  const household = households.find((h) => h.id === preferred) ?? households[0] ?? null;
  const switchTo = useCallback((id: string) => { setActiveHouseholdId(id); setPreferred(id); }, []);
  return { household, households, switchTo };
}
