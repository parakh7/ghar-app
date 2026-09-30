import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttendanceRecordDTO, MarkAttendanceInput, MarkHolidayResultDTO, TodayAttendanceDTO } from "@household/shared";
import { del, get, post, put } from "../../../lib/api";

export function useTodayAttendance(householdId: string | undefined) {
  return useQuery({
    queryKey: ["attendance", "today", householdId],
    queryFn: ({ signal }) => get<TodayAttendanceDTO>(`/households/${householdId}/attendance/today`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

function invalidateAttendance(qc: ReturnType<typeof useQueryClient>, householdId: string, househelpId?: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["attendance", "today", householdId] }),
    qc.invalidateQueries({ queryKey: househelpId ? ["attendance", "month", householdId, househelpId] : ["attendance", "month", householdId] }),
  ]);
}

export function useSetAttendance(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, body }: { househelpId: string; body: MarkAttendanceInput }) =>
      put<AttendanceRecordDTO>(`/households/${householdId}/attendance/${househelpId}`, body),
    onSuccess: (_data, { househelpId }) => invalidateAttendance(qc, householdId, househelpId),
  });
}

export function useClearAttendance(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, date }: { househelpId: string; date: string }) =>
      del<null>(`/households/${householdId}/attendance/${househelpId}?date=${date}`),
    onSuccess: (_data, { househelpId }) => invalidateAttendance(qc, householdId, househelpId),
  });
}

export function useMarkHoliday(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => post<MarkHolidayResultDTO>(`/households/${householdId}/attendance/holiday`, { date }),
    onSuccess: () => invalidateAttendance(qc, householdId),
  });
}

export function useMonthAttendance(householdId: string | undefined, househelpId: string | undefined, month: string) {
  return useQuery({
    queryKey: ["attendance", "month", householdId, househelpId, month],
    queryFn: ({ signal }) => get<AttendanceRecordDTO[]>(`/households/${householdId}/househelps/${househelpId}/attendance?month=${month}`, signal).then((r) => r.data),
    enabled: !!householdId && !!househelpId,
  });
}
