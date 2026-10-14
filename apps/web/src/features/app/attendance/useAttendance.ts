import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttendanceRecordDTO, MarkAttendanceInput, MarkHolidayResultDTO, MarkRemainingPresentResultDTO, TodayAttendanceDTO } from "@household/shared";
import { ApiError, del, get, post, put } from "../../../lib/api";
import { enqueueMutation } from "../../../lib/offline-queue";

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
    mutationFn: async ({ househelpId, body }: { househelpId: string; body: MarkAttendanceInput }) => {
      try {
        const result = await put<AttendanceRecordDTO>(`/households/${householdId}/attendance/${househelpId}`, body);
        return { ...result, queued: false };
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "NETWORK_ERROR") throw err;
        const clientMutationId = crypto.randomUUID();
        await enqueueMutation({
          type: "attendance", householdId, clientMutationId,
          endpoint: `/households/${householdId}/attendance/${househelpId}`,
          body: { ...body, clientMutationId },
          pendingKey: `attendance:${househelpId}:${body.date}`,
          createdAt: new Date().toISOString(),
        });
        const optimistic: AttendanceRecordDTO = { date: body.date, status: body.status, note: body.note ?? null };
        qc.setQueryData(["attendance", "today", householdId], (old: TodayAttendanceDTO | undefined) =>
          old ? { ...old, entries: old.entries.map((e) => (e.househelpId === househelpId ? { ...e, status: optimistic.status, note: optimistic.note } : e)) } : old);
        return { data: optimistic, message: null, queued: true };
      }
    },
    // Skip invalidation for a queued (not actually synced) write — a background refetch here
    // could succeed against stale server data and silently overwrite the optimistic update
    // before the queued mutation has actually replayed.
    onSuccess: (result, { househelpId }) => { if (!result.queued) void invalidateAttendance(qc, householdId, househelpId); },
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

export function useMarkRemainingPresent(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ househelpId, month }: { househelpId: string; month: string }) =>
      post<MarkRemainingPresentResultDTO>(`/households/${householdId}/househelps/${househelpId}/attendance/remaining-present`, { month }),
    onSuccess: (_data, { househelpId }) => invalidateAttendance(qc, householdId, househelpId),
  });
}

export function useMonthAttendance(householdId: string | undefined, househelpId: string | undefined, month: string) {
  return useQuery({
    queryKey: ["attendance", "month", householdId, househelpId, month],
    queryFn: ({ signal }) => get<AttendanceRecordDTO[]>(`/households/${householdId}/househelps/${househelpId}/attendance?month=${month}`, signal).then((r) => r.data),
    enabled: !!householdId && !!househelpId,
  });
}
