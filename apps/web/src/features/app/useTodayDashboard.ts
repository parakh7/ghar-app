import { useQuery } from "@tanstack/react-query";
import type { TodayDashboardDTO } from "@household/shared";
import { get } from "../../lib/api";

export function useTodayDashboard(householdId: string | undefined) {
  return useQuery({
    queryKey: ["today-dashboard", householdId],
    queryFn: ({ signal }) => get<TodayDashboardDTO>(`/households/${householdId}/today`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}
