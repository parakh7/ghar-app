import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BillCategoryDTO, BillDTO, CreateBillCategoryInput, CreateBillInput, MoveCategoryInput, UpdateBillCategoryInput, UpdateBillInput } from "@household/shared";
import { del, get, patch, post } from "../../../lib/api";

export function useBillCategories(householdId: string | undefined) {
  return useQuery({
    queryKey: ["bill-categories", householdId],
    queryFn: ({ signal }) => get<BillCategoryDTO[]>(`/households/${householdId}/bill-categories`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useCreateBillCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBillCategoryInput) => post<BillCategoryDTO>(`/households/${householdId}/bill-categories`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-categories", householdId] }),
  });
}

export function useUpdateBillCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, body }: { categoryId: string; body: UpdateBillCategoryInput }) => patch<BillCategoryDTO>(`/households/${householdId}/bill-categories/${categoryId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-categories", householdId] }),
  });
}

export function useDeleteBillCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) => del<null>(`/households/${householdId}/bill-categories/${categoryId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-categories", householdId] }),
  });
}

export function useMoveBillCategory(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, direction }: { categoryId: string; direction: MoveCategoryInput["direction"] }) =>
      post<null>(`/households/${householdId}/bill-categories/${categoryId}/move`, { direction }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-categories", householdId] }),
  });
}

export function useBills(householdId: string | undefined, includeArchived: boolean) {
  return useQuery({
    queryKey: ["bills", householdId, includeArchived],
    queryFn: ({ signal }) => get<BillDTO[]>(`/households/${householdId}/bills${includeArchived ? "?includeArchived=true" : ""}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useBill(householdId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["bill", householdId, id],
    queryFn: ({ signal }) => get<BillDTO>(`/households/${householdId}/bills/${id}`, signal).then((r) => r.data),
    enabled: !!householdId && !!id,
  });
}

function invalidateBillQueries(qc: ReturnType<typeof useQueryClient>, householdId: string, id?: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["bills", householdId] }),
    ...(id ? [qc.invalidateQueries({ queryKey: ["bill", householdId, id] })] : []),
  ]);
}

export function useCreateBill(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateBillInput) => post<BillDTO>(`/households/${householdId}/bills`, body),
    onSuccess: () => invalidateBillQueries(qc, householdId),
  });
}

export function useUpdateBill(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateBillInput }) => patch<BillDTO>(`/households/${householdId}/bills/${id}`, body),
    onSuccess: (_data, { id }) => invalidateBillQueries(qc, householdId, id),
  });
}

export function usePauseBill(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/bills/${id}/pause`),
    onSuccess: (_data, id) => invalidateBillQueries(qc, householdId, id),
  });
}

export function useResumeBill(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/bills/${id}/resume`),
    onSuccess: (_data, id) => invalidateBillQueries(qc, householdId, id),
  });
}

export function useArchiveBill(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/bills/${id}/archive`),
    onSuccess: (_data, id) => invalidateBillQueries(qc, householdId, id),
  });
}

export function useUnarchiveBill(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<null>(`/households/${householdId}/bills/${id}/unarchive`),
    onSuccess: (_data, id) => invalidateBillQueries(qc, householdId, id),
  });
}
