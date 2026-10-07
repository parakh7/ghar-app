import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BillCategoryDTO, BillDTO, BillOccurrenceDTO, BillPaymentDTO, CreateBillCategoryInput, CreateBillInput,
  MoveCategoryInput, RecordBillPaymentInput, UpdateBillCategoryInput, UpdateBillInput, UpdateOccurrenceAmountInput,
  WaiveOccurrenceInput,
} from "@household/shared";
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
    ...(id
      ? [
          qc.invalidateQueries({ queryKey: ["bill", householdId, id] }),
          // Mutations like resume/unarchive call `ensureOccurrences` server-side, which can change
          // the occurrence schedule without the bill detail page remounting — invalidate this too
          // so `useOccurrences` resyncs instead of showing a stale list until a manual refresh.
          qc.invalidateQueries({ queryKey: ["bill-occurrences", householdId, id] }),
        ]
      : []),
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
 * Lists a bill's occurrences, syncing first — the endpoint is idempotent and `bills.view`-gated
 * specifically so it's safe to call on every page load with no permission check.
 *
 * The sync call and the read live in ONE sequential `queryFn`, not a separate `useEffect` firing a
 * sync alongside `useQuery`'s own independent GET: two concurrent HTTP round trips have no ordering
 * guarantee, so if the GET resolved after a sync-triggered cache write landed, the GET's response
 * would silently overwrite the cache with pre-sync (stale) data. Sequencing them in one `queryFn`
 * means the GET (when it runs at all) only ever happens after the sync it's reporting on.
 *
 * The sync response already IS the refreshed list (the route handler returns `listOccurrences`
 * right after `ensureOccurrences`), so the common path returns it directly with no second request.
 * The GET only runs as a fallback for when sync itself fails (offline, timeout, etc.) — best-effort,
 * so a failed background refresh still shows whatever already exists rather than blocking the page.
 */
export function useOccurrences(householdId: string | undefined, billId: string | undefined) {
  return useQuery({
    queryKey: ["bill-occurrences", householdId, billId],
    queryFn: async ({ signal }) => {
      try {
        const synced = await post<BillOccurrenceDTO[]>(`/households/${householdId}/bills/${billId}/occurrences/sync`);
        return synced.data;
      } catch {
        return get<BillOccurrenceDTO[]>(`/households/${householdId}/bills/${billId}/occurrences`, signal).then((r) => r.data);
      }
    },
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

export function useOccurrencePayments(householdId: string | undefined, billId: string | undefined, occurrenceId: string | undefined) {
  return useQuery({
    queryKey: ["bill-occurrence-payments", householdId, billId, occurrenceId],
    queryFn: ({ signal }) =>
      get<BillPaymentDTO[]>(`/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/payments`, signal).then((r) => r.data),
    enabled: !!householdId && !!billId && !!occurrenceId,
  });
}

/**
 * Payment record/void and waive/unwaive all change the occurrence's own status/amountPaidPaise, so
 * every one of these mutations must invalidate the occurrence-list key alongside whatever's specific
 * to it (same lesson as Spec 2's final-review fix for `invalidateBillQueries` above) — otherwise the
 * list keeps showing a stale status/amount after a successful mutation until an unrelated refetch.
 */
function invalidateOccurrenceQueries(qc: ReturnType<typeof useQueryClient>, householdId: string, billId: string, occurrenceId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["bill-occurrences", householdId, billId] }),
    qc.invalidateQueries({ queryKey: ["bill-occurrence-payments", householdId, billId, occurrenceId] }),
  ]);
}

export function useRecordPayment(householdId: string, billId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ occurrenceId, body }: { occurrenceId: string; body: RecordBillPaymentInput }) =>
      post<BillPaymentDTO>(`/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/payments`, body),
    onSuccess: (_data, { occurrenceId }) => invalidateOccurrenceQueries(qc, householdId, billId, occurrenceId),
  });
}

export function useVoidPayment(householdId: string, billId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ occurrenceId, paymentId, reason }: { occurrenceId: string; paymentId: string; reason?: string }) =>
      del<null>(`/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/payments/${paymentId}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`),
    onSuccess: (_data, { occurrenceId }) => invalidateOccurrenceQueries(qc, householdId, billId, occurrenceId),
  });
}

export function useWaiveOccurrence(householdId: string, billId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ occurrenceId, body }: { occurrenceId: string; body: WaiveOccurrenceInput }) =>
      post<BillOccurrenceDTO>(`/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/waive`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-occurrences", householdId, billId] }),
  });
}

export function useUnwaiveOccurrence(householdId: string, billId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (occurrenceId: string) => post<BillOccurrenceDTO>(`/households/${householdId}/bills/${billId}/occurrences/${occurrenceId}/unwaive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bill-occurrences", householdId, billId] }),
  });
}
