import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationPreferenceDTO, UpdateNotificationPreferenceInput } from "@household/shared";
import { get, patch } from "../../lib/api";

export function useNotificationPreferences(householdId: string | undefined) {
  return useQuery({
    queryKey: ["notification-preferences", householdId],
    queryFn: ({ signal }) => get<NotificationPreferenceDTO[]>(`/households/${householdId}/notification-preferences`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useUpdateNotificationPreference(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ category, body }: { category: string; body: UpdateNotificationPreferenceInput }) =>
      patch<NotificationPreferenceDTO>(`/households/${householdId}/notification-preferences/${category}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-preferences", householdId] }),
  });
}
