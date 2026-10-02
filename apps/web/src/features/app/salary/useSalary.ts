import { useMemo } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdjustmentDTO, CreateAdjustmentInput, GenerateSettlementInput,
  RecordPaymentInput, SalaryPaymentDTO, SettlementDTO,
} from "@household/shared";
import { del, get, post } from "../../../lib/api";
import { useHousehelps } from "../househelps/useHousehelps";

export type SettlementDetailDTO = SettlementDTO & { adjustments: AdjustmentDTO[]; payments: SalaryPaymentDTO[] };

export function useHousehelpSettlements(householdId: string | undefined, househelpId: string | undefined) {
  return useQuery({
    queryKey: ["salary-settlements", householdId, househelpId],
    queryFn: ({ signal }) => get<SettlementDTO[]>(`/households/${householdId}/househelps/${househelpId}/salary/settlements`, signal).then((r) => r.data),
    enabled: !!householdId && !!househelpId,
  });
}

export function useSettlement(householdId: string | undefined, settlementId: string | undefined) {
  return useQuery({
    queryKey: ["salary-settlement", householdId, settlementId],
    queryFn: ({ signal }) => get<SettlementDetailDTO>(`/households/${householdId}/salary/settlements/${settlementId}`, signal).then((r) => r.data),
    enabled: !!householdId && !!settlementId,
  });
}

function invalidateSalary(qc: ReturnType<typeof useQueryClient>, householdId: string, househelpId?: string, settlementId?: string) {
  return Promise.all([
    ...(househelpId ? [qc.invalidateQueries({ queryKey: ["salary-settlements", householdId, househelpId] })] : []),
    ...(settlementId ? [qc.invalidateQueries({ queryKey: ["salary-settlement", householdId, settlementId] })] : []),
  ]);
}

export function useGenerateSettlement(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, body }: { househelpId: string; body: GenerateSettlementInput }) =>
      post<SettlementDTO>(`/households/${householdId}/househelps/${househelpId}/salary/settlements`, body),
    onSuccess: (result, { househelpId }) => invalidateSalary(qc, householdId, househelpId, result.data.id),
  });
}

export function useCreateAdjustment(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, body }: { househelpId: string; settlementId?: string; body: CreateAdjustmentInput }) =>
      post<AdjustmentDTO>(`/households/${householdId}/househelps/${househelpId}/salary/adjustments`, body),
    onSuccess: (_data, { househelpId, settlementId }) => invalidateSalary(qc, householdId, househelpId, settlementId),
  });
}

export function useVoidAdjustment(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ adjustmentId }: { adjustmentId: string; househelpId?: string; settlementId?: string }) =>
      del<null>(`/households/${householdId}/salary/adjustments/${adjustmentId}`),
    onSuccess: (_data, { househelpId, settlementId }) => invalidateSalary(qc, householdId, househelpId, settlementId),
  });
}

export function useRecordPayment(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ settlementId, body }: { settlementId: string; househelpId?: string; body: RecordPaymentInput }) =>
      post<SalaryPaymentDTO>(`/households/${householdId}/salary/settlements/${settlementId}/payments`, body),
    onSuccess: (_data, { househelpId, settlementId }) => invalidateSalary(qc, householdId, househelpId, settlementId),
  });
}

export function useVoidPayment(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason?: string; househelpId?: string; settlementId?: string }) =>
      del<null>(`/households/${householdId}/salary/payments/${paymentId}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`),
    onSuccess: (_data, { househelpId, settlementId }) => invalidateSalary(qc, householdId, househelpId, settlementId),
  });
}

/**
 * Household-wide "what's due soonest" view for the Home card. The API only lists settlements
 * per househelp (there's no household-wide settlements endpoint), so this fans out one list
 * query per active househelp and picks the non-final settlement with the nearest due date.
 * `enabled` lets callers skip the whole fan-out when the viewer lacks salaries.view.
 */
export function useUpcomingSettlement(householdId: string | undefined, enabled: boolean) {
  const househelpsQuery = useHousehelps(enabled ? householdId : undefined, false);
  const househelps = useMemo(() => househelpsQuery.data ?? [], [househelpsQuery.data]);

  const results = useQueries({
    queries: househelps.map((h) => ({
      queryKey: ["salary-settlements", householdId, h.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        get<SettlementDTO[]>(`/households/${householdId}/househelps/${h.id}/salary/settlements`, signal).then((r) => r.data),
      enabled: enabled && !!householdId,
    })),
  });

  const isLoading = (enabled && househelpsQuery.isLoading) || results.some((r) => r.isLoading);
  const hasAnySettlement = results.some((r) => (r.data?.length ?? 0) > 0);

  const upcoming = useMemo(() => {
    const flat = results.flatMap((r, i) => (r.data ?? []).map((settlement) => ({ settlement, househelpName: househelps[i]!.name })));
    const unpaid = flat.filter((x) => x.settlement.status !== "PAID" && x.settlement.status !== "CANCELLED");
    unpaid.sort((a, b) => a.settlement.dueDate.localeCompare(b.settlement.dueDate));
    return unpaid[0] ?? null;
  }, [results, househelps]);

  return { isLoading, hasAnySettlement, upcoming };
}
