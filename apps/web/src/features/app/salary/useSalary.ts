import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdjustmentDTO, CreateAdjustmentInput, GenerateSettlementInput,
  RecordPaymentInput, SalaryPaymentDTO, SettlementDTO,
} from "@household/shared";
import { del, get, post } from "../../../lib/api";

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
