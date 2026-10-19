import { and, eq } from "drizzle-orm";
import type { NotificationPreferenceDTO, SettableNotificationCategory, UpdateNotificationPreferenceInput } from "@household/shared";
import { notificationPreferences } from "../db/schema.js";
import { Errors } from "../lib/errors.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

type PrefRow = typeof notificationPreferences.$inferSelect;
type ChannelValue = "IN_APP" | "WEB_PUSH" | "EMAIL" | "SMS" | "WHATSAPP";

const DEFAULT_CHANNELS: ChannelValue[] = ["IN_APP", "WEB_PUSH"];
const SETTABLE_CATEGORIES: SettableNotificationCategory[] = ["BILL", "SALARY"];

function toDTO(category: SettableNotificationCategory, row: PrefRow | undefined): NotificationPreferenceDTO {
  const enabled = row?.enabled ?? true;
  const channels = row?.channels ?? DEFAULT_CHANNELS;
  return { category, enabled, emailEnabled: channels.includes("EMAIL"), pushEnabled: channels.includes("WEB_PUSH") };
}

export async function listNotificationPreferences(deps: Deps, userId: string, membership: Membership): Promise<NotificationPreferenceDTO[]> {
  const rows = await deps.db.select().from(notificationPreferences)
    .where(and(eq(notificationPreferences.householdId, membership.householdId), eq(notificationPreferences.userId, userId)));
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  return SETTABLE_CATEGORIES.map((category) => toDTO(category, byCategory.get(category)));
}

export async function updateNotificationPreference(
  deps: Deps, userId: string, membership: Membership, category: string, input: UpdateNotificationPreferenceInput,
): Promise<NotificationPreferenceDTO> {
  if (!SETTABLE_CATEGORIES.includes(category as SettableNotificationCategory)) throw Errors.validation({ category: "Unsupported category." });
  const cat = category as SettableNotificationCategory;

  const result = await deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(notificationPreferences)
      .where(and(eq(notificationPreferences.householdId, membership.householdId), eq(notificationPreferences.userId, userId), eq(notificationPreferences.category, cat)))
      .for("update");

    const enabled = input.enabled ?? existing?.enabled ?? true;
    const currentChannels = existing?.channels ?? DEFAULT_CHANNELS;
    const afterEmail: ChannelValue[] = input.emailEnabled === undefined
      ? currentChannels
      : input.emailEnabled
        ? currentChannels.includes("EMAIL") ? currentChannels : [...currentChannels, "EMAIL"]
        : currentChannels.filter((c) => c !== "EMAIL");
    const channels: ChannelValue[] = input.pushEnabled === undefined
      ? afterEmail
      : input.pushEnabled
        ? afterEmail.includes("WEB_PUSH") ? afterEmail : [...afterEmail, "WEB_PUSH"]
        : afterEmail.filter((c) => c !== "WEB_PUSH");

    if (existing) {
      await tx.update(notificationPreferences).set({ enabled, channels }).where(eq(notificationPreferences.id, existing.id));
    } else {
      await tx.insert(notificationPreferences).values({ householdId: membership.householdId, userId, category: cat, enabled, channels });
    }
    return { enabled, channels };
  });

  return { category: cat, enabled: result.enabled, emailEnabled: result.channels.includes("EMAIL"), pushEnabled: result.channels.includes("WEB_PUSH") };
}
