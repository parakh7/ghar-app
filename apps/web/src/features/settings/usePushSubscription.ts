import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { post } from "../../lib/api";
import { getPushSupportState, subscribeToPush, unsubscribeFromPush } from "../../lib/push";

const SUPPORT_KEY = ["push-support-state"];

export function usePushSupportState() {
  return useQuery({ queryKey: SUPPORT_KEY, queryFn: getPushSupportState });
}

export function useSubscribeToPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!vapidKey) throw new Error("Push notifications aren't configured for this deployment.");
      const subscription = await subscribeToPush(vapidKey);
      await post("/push-subscriptions", { endpoint: subscription.endpoint, keys: subscription.keys, userAgent: navigator.userAgent });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }),
  });
}

export function useUnsubscribeFromPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const endpoint = await unsubscribeFromPush();
      if (endpoint) await post("/push-subscriptions/unsubscribe", { endpoint });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: SUPPORT_KEY }),
  });
}

export function useSendTestPushNotification(householdId: string) {
  return useMutation({
    mutationFn: () =>
      post<{ delivered: boolean; reason?: string }>(`/households/${householdId}/notifications/test-push`).then((r) => r.data),
  });
}
