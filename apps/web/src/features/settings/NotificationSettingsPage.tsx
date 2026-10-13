import type { NotificationPreferenceDTO, SettableNotificationCategory } from "@household/shared";
import { useActiveHousehold } from "../app/useActiveHousehold";
import { useNotificationPreferences, useUpdateNotificationPreference } from "./useNotificationPreferences";

const CATEGORY_LABEL: Record<SettableNotificationCategory, string> = { BILL: "Bills", SALARY: "Salary" };

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

  return (
    <>
      <header className="page-head"><h1 className="page-title">Notification settings</h1></header>
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
              <button type="button" className="chip" aria-pressed={pref.emailEnabled} onClick={() => onToggleEmail(pref)}>
                Also email me
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
