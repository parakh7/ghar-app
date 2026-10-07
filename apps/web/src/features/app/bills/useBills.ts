import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BillCategoryDTO, BillDTO, BillOccurrenceDTO, CreateBillCategoryInput, CreateBillInput, MoveCategoryInput, UpdateBillCategoryInput, UpdateBillInput, UpdateOccurrenceAmountInput } from "@household/shared";
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

/**
 * Lists a bill's occurrences, kicking off a background `/sync` on mount first — the endpoint is
 * idempotent and `bills.view`-gated specifically so it's safe to fire on every page load with no
 * permission check. Writes the synced list straight into the query cache on success (rather than
 * just invalidating) so the page renders fresh data as soon as it lands instead of waiting on a
 * second round trip; sync failing is swallowed because the plain GET query below still renders
 * whatever occurrences already exist, so a failed background refresh shouldn't block the page.
 */
export function useOccurrences(householdId: string | undefined, billId: string | undefined) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!householdId || !billId) return;
    post<BillOccurrenceDTO[]>(`/households/${householdId}/bills/${billId}/occurrences/sync`)
      .then((r) => qc.setQueryData(["bill-occurrences", householdId, billId], r.data))
      .catch(() => {
        // Best-effort: the GET query below still has whatever was already cached/fetched.
      });
  }, [householdId, billId, qc]);

  return useQuery({
    queryKey: ["bill-occurrences", householdId, billId],
    queryFn: ({ signal }) => get<BillOccurrenceDTO[]>(`/households/${householdId}/bills/${billId}/occurrences`, signal).then((r) => r.data),
    enabled: !!householdId && !!billId,
  });
}

export function useUpdateOccurrenceAmount(householdId: string, billId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ occurrenceId, body }: { occurrenceId: string; body: UpdateOccurrenceAmountInput }) =>
      patch<BillOccurrenceDTO>(`/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-occurrences", householdId, billId] }),
  });
}
