import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompletionStatus, MarkCompletionInput, TodayChecklistDTO } from "@household/shared";
import { del, get, put } from "../../../lib/api";

type ChecklistCompletionRecordDTO = { date: string; status: CompletionStatus; note: string | null };

export function useTodayChecklist(householdId: string | undefined) {
  return useQuery({
    queryKey: ["checklist", "today", householdId],
    queryFn: ({ signal }) => get<TodayChecklistDTO>(`/households/${householdId}/checklist/today`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

function invalidateChecklist(qc: ReturnType<typeof useQueryClient>, householdId: string) {
  return qc.invalidateQueries({ queryKey: ["checklist", "today", householdId] });
}

export function useMarkCompletion(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, body }: { taskId: string; body: MarkCompletionInput }) =>
      put<ChecklistCompletionRecordDTO>(`/households/${householdId}/checklist/${taskId}/completion`, body),
    onSuccess: () => invalidateChecklist(qc, householdId),
  });
}

export function useClearCompletion(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, date }: { taskId: string; date: string }) =>
      del<null>(`/households/${householdId}/checklist/${taskId}/completion?date=${date}`),
    onSuccess: () => invalidateChecklist(qc, householdId),
  });
}
