import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { post } from "../../lib/api";
import { getExistingSubscriptionJSON, getPushSupportState, subscribeToPush, unsubscribeFromPush } from "../../lib/push";

const SUPPORT_KEY = ["push-support-state"];

export function usePushSupportState() {
  return useQuery({ queryKey: SUPPORT_KEY, queryFn: getPushSupportState });
}

/** Best-effort self-heal: if the browser already holds a push subscription, re-POST it to the
 *  server so a stale/missing server-side row (e.g. revoked after a 410, or never successfully
 *  saved after a prior subscribe flow failed partway) gets re-created. The subscribe endpoint is
 *  idempotent (onConflictDoUpdate), so re-POSTing a subscription the server already has is a safe
 *  no-op. Fire-and-forget: errors are swallowed since this isn't a user-initiated action. */
export function useSyncPushSubscription() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await getExistingSubscriptionJSON();
        if (cancelled || !existing) return;
        await post("/push-subscriptions", { endpoint: existing.endpoint, keys: existing.keys, userAgent: navigator.userAgent });
      } catch {
        // best-effort background self-heal; nothing to surface to the user
      }
    })();
    return () => { cancelled = true; };
  }, []);
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
