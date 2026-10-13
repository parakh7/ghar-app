import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationDTO } from "@household/shared";
import { get, patch, post } from "../../lib/api";

export function useNotifications(householdId: string | undefined) {
  return useQuery({
    queryKey: ["notifications", householdId],
    queryFn: ({ signal }) => get<NotificationDTO[]>(`/households/${householdId}/notifications`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

/** This app's only polled query — don't generalize the interval into a shared utility for one caller. */
export function useUnreadCount(householdId: string | undefined) {
  return useQuery({
    queryKey: ["notifications-unread-count", householdId],
    queryFn: ({ signal }) => get<{ count: number }>(`/households/${householdId}/notifications/unread-count`, signal).then((r) => r.data.count),
    enabled: !!householdId,
    refetchInterval: 60_000,
  });
}

function invalidateNotificationQueries(qc: ReturnType<typeof useQueryClient>, householdId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["notifications", householdId] }),
    qc.invalidateQueries({ queryKey: ["notifications-unread-count", householdId] }),
  ]);
}

export function useMarkNotificationRead(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => patch<NotificationDTO>(`/households/${householdId}/notifications/${id}`, { action: "read" }),
    onSuccess: () => invalidateNotificationQueries(qc, householdId),
  });
}

export function useDismissNotification(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => patch<NotificationDTO>(`/households/${householdId}/notifications/${id}`, { action: "dismiss" }),
    onSuccess: () => invalidateNotificationQueries(qc, householdId),
  });
}

export function useMarkAllRead(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<null>(`/households/${householdId}/notifications/mark-all-read`),
    onSuccess: () => invalidateNotificationQueries(qc, householdId),
  });
}
