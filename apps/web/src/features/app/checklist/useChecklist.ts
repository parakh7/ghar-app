import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChecklistTaskDTO, CreateChecklistTaskInput, MoveCategoryInput, PutAssignmentsInput, UpdateChecklistTaskInput } from "@household/shared";
import { get, patch, post, put } from "../../../lib/api";

export function useChecklistTasks(householdId: string | undefined, includeArchived: boolean) {
  return useQuery({
    queryKey: ["checklist-tasks", householdId, includeArchived],
    queryFn: ({ signal }) => get<ChecklistTaskDTO[]>(`/households/${householdId}/checklist-tasks${includeArchived ? "?includeArchived=true" : ""}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useChecklistTask(householdId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["checklist-task", householdId, id],
    queryFn: ({ signal }) => get<ChecklistTaskDTO>(`/households/${householdId}/checklist-tasks/${id}`, signal).then((r) => r.data),
    enabled: !!householdId && !!id,
  });
}

function invalidateChecklistTaskQueries(qc: ReturnType<typeof useQueryClient>, householdId: string, id?: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["checklist-tasks", householdId] }),
    ...(id ? [qc.invalidateQueries({ queryKey: ["checklist-task", householdId, id] })] : []),
  ]);
}

export function useCreateChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateChecklistTaskInput) => post<ChecklistTaskDTO>(`/households/${householdId}/checklist-tasks`, body),
    onSuccess: () => invalidateChecklistTaskQueries(qc, householdId),
  });
}

export function useUpdateChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateChecklistTaskInput }) => patch<ChecklistTaskDTO>(`/households/${householdId}/checklist-tasks/${id}`, body),
    onSuccess: (_data, { id }) => invalidateChecklistTaskQueries(qc, householdId, id),
  });
}

export function useArchiveChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/checklist-tasks/${id}/archive`),
    onSuccess: (_data, id) => invalidateChecklistTaskQueries(qc, householdId, id),
  });
}

export function useUnarchiveChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/checklist-tasks/${id}/unarchive`),
    onSuccess: (_data, id) => invalidateChecklistTaskQueries(qc, householdId, id),
  });
}

export function useMoveChecklistTask(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: MoveCategoryInput["direction"] }) => post<null>(`/households/${householdId}/checklist-tasks/${id}/move`, { direction }),
    onSuccess: () => invalidateChecklistTaskQueries(qc, householdId),
  });
}

export function useChecklistAssignments(householdId: string | undefined, taskId: string | undefined) {
  return useQuery({
    queryKey: ["checklist-assignments", householdId, taskId],
    queryFn: ({ signal }) => get<string[]>(`/households/${householdId}/checklist-tasks/${taskId}/assignments`, signal).then((r) => r.data),
    enabled: !!householdId && !!taskId,
  });
}

export function usePutChecklistAssignments(householdId: string, taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PutAssignmentsInput) => put<string[]>(`/households/${householdId}/checklist-tasks/${taskId}/assignments`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["checklist-assignments", householdId, taskId] }),
  });
}
