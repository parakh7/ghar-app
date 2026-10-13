import { useQuery } from "@tanstack/react-query";
import type { ReportDTO, ReportType } from "@household/shared";
import { get } from "../../lib/api";

export function useReport(householdId: string | undefined, type: ReportType, month: string) {
  return useQuery({
    queryKey: ["report", householdId, type, month],
    queryFn: ({ signal }) => get<ReportDTO>(`/households/${householdId}/reports?type=${type}&month=${month}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}
