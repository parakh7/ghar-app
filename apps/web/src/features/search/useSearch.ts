import { useQuery } from "@tanstack/react-query";
import type { SearchResultsDTO } from "@household/shared";
import { get } from "../../lib/api";

export function useSearch(householdId: string | undefined, query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["search", householdId, trimmed],
    queryFn: ({ signal }) => get<SearchResultsDTO>(`/households/${householdId}/search?q=${encodeURIComponent(trimmed)}`, signal).then((r) => r.data),
    enabled: !!householdId && trimmed.length > 0,
  });
}
