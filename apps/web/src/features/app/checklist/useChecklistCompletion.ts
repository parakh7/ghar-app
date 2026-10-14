import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompletionStatus, MarkCompletionInput, TodayChecklistDTO } from "@household/shared";
import { ApiError, del, get, put } from "../../../lib/api";
import { enqueueMutation } from "../../../lib/offline-queue";

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
    mutationFn: async ({ taskId, body }: { taskId: string; body: MarkCompletionInput }) => {
      try {
        return await put<ChecklistCompletionRecordDTO>(`/households/${householdId}/checklist/${taskId}/completion`, body);
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "NETWORK_ERROR") throw err;
        const clientMutationId = crypto.randomUUID();
        await enqueueMutation({
          type: "checklist", householdId, clientMutationId,
          endpoint: `/households/${householdId}/checklist/${taskId}/completion`,
          body: { ...body, clientMutationId },
          pendingKey: `checklist:${taskId}:${body.date}`,
          createdAt: new Date().toISOString(),
        });
        const optimistic: ChecklistCompletionRecordDTO = { date: body.date, status: body.status, note: body.note ?? null };
        qc.setQueryData(["checklist", "today", householdId], (old: TodayChecklistDTO | undefined) =>
          old ? { ...old, entries: old.entries.map((e) => (e.taskId === taskId ? { ...e, status: optimistic.status, note: optimistic.note } : e)) } : old);
        return { data: optimistic, message: null };
      }
    },
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
