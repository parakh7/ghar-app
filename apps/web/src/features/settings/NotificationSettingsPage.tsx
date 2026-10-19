import type { NotificationPreferenceDTO, SettableNotificationCategory } from "@household/shared";
import { PushPermissionDeniedError } from "../../lib/push";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useNotificationPreferences, useUpdateNotificationPreference } from "./useNotificationPreferences";
import { usePushSupportState, useSendTestPushNotification, useSubscribeToPush, useUnsubscribeFromPush } from "./usePushSubscription";

const CATEGORY_LABEL: Record<SettableNotificationCategory, string> = { BILL: "Bills", SALARY: "Salary" };

function PushSubscriptionSection({ householdId }: { householdId: string }) {
  const supportQuery = usePushSupportState();
  const subscribeMutation = useSubscribeToPush();
  const unsubscribeMutation = useUnsubscribeFromPush();
  const testMutation = useSendTestPushNotification(householdId);

  if (!supportQuery.data) return null;
  const state = supportQuery.data;

  if (state === "unsupported") {
    return <p className="list__item">Browser notifications aren't supported on this device.</p>;
  }
  if (state === "denied") {
    return <p className="list__item">Notifications are blocked for this site — enable them in your browser's site settings.</p>;
  }

  if (state === "subscribed") {
    return (
      <div className="list__item" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--space-2)" }}>
        <span className="list__label">Enabled on this device</span>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button type="button" className="chip" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            Send test notification
          </button>
          <button type="button" className="chip" onClick={() => unsubscribeMutation.mutate()} disabled={unsubscribeMutation.isPending}>
            Turn off on this device
          </button>
        </div>
        {testMutation.isSuccess && (
          <span>{testMutation.data.delivered ? "Sent — check for a notification." : "Not sent: no active device found."}</span>
        )}
      </div>
    );
  }

  return (
    <div className="list__item" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--space-2)" }}>
      <button type="button" className="chip" onClick={() => subscribeMutation.mutate()} disabled={subscribeMutation.isPending}>
        Enable browser notifications
      </button>
      {subscribeMutation.isError && (
        <span>{subscribeMutation.error instanceof PushPermissionDeniedError ? "Notification permission was denied." : subscribeMutation.error.message}</span>
      )}
    </div>
  );
}

export function NotificationSettingsPage() {
  const { household } = useActiveHousehold();
  const householdId = household?.id;
  const prefsQuery = useNotificationPreferences(householdId);
  const updatePref = useUpdateNotificationPreference(householdId ?? "");

  if (!householdId || !prefsQuery.data) return null;

  function onToggleEnabled(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { enabled: !pref.enabled } });
  }

  function onToggleEmail(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { emailEnabled: !pref.emailEnabled } });
  }

  function onTogglePush(pref: NotificationPreferenceDTO) {
    updatePref.mutate({ category: pref.category, body: { pushEnabled: !pref.pushEnabled } });
  }

  return (
    <>
      <header className="page-head"><h1 className="page-title">Notification settings</h1></header>
      <PushSubscriptionSection householdId={householdId} />
      <div className="list">
        {prefsQuery.data.map((pref) => (
          <div key={pref.category} className="list__item" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--space-2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="list__label">{CATEGORY_LABEL[pref.category]}</span>
              <button type="button" className="chip" aria-pressed={pref.enabled} onClick={() => onToggleEnabled(pref)}>
                {pref.enabled ? "On" : "Off"}
              </button>
            </div>
            {pref.enabled && (
              <>
                <button type="button" className="chip" aria-pressed={pref.emailEnabled} onClick={() => onToggleEmail(pref)}>
                  Also email me
                </button>
                <button type="button" className="chip" aria-pressed={pref.pushEnabled} onClick={() => onTogglePush(pref)}>
                  Also notify on this device
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
