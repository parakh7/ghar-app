import { and, eq, isNull } from "drizzle-orm";
import { dateInZone, hourInZone, type ISODate } from "@household/shared";
import { households, householdMembers, notifications, notificationDeliveries, notificationPreferences } from "../db/schema.js";
import type { Deps } from "../services/deps.js";
import { getDueBillOccurrences, getDueSettlements, type DueBillOccurrence, type DueSettlement } from "../services/reminder-evaluation.service.js";

/**
 * True only for a unique-violation on `notifications_idempotency_uq` specifically — the one
 * constraint a re-run of this job is expected to hit (same item, same hour, already notified).
 * Any other 23505 (e.g. `notification_deliveries_uq`, which a caller-supplied duplicate channel
 * in `channels` would trip) must NOT be swallowed here: that would roll back the whole transaction
 * (notification + every delivery) while this catch reports it as a harmless no-op, silently
 * dropping a reminder with no notification, no deliveries, and no error. Node-postgres errors
 * raised inside `deps.db.transaction` come back wrapped by drizzle as `DrizzleQueryError`, with the
 * real `pg` error (carrying `code`/`constraint`) on `.cause` — but check both shapes defensively in
 * case that wrapping ever changes.
 */
function isIdempotencyKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const code = e?.code ?? e?.cause?.code;
  const constraint = e?.constraint ?? e?.cause?.constraint;
  return code === "23505" && constraint === "notifications_idempotency_uq";
}

type NotificationChannelValue = "IN_APP" | "WEB_PUSH" | "EMAIL" | "SMS" | "WHATSAPP";
const DEFAULT_CHANNELS: readonly NotificationChannelValue[] = ["IN_APP", "WEB_PUSH"];

type Outcome = { kind: "before"; offset: number } | { kind: "overdue" };

/** `matchedOffsets` has at most one entry (offsetsDaysSchema forbids duplicates); overdue and a
 * matched offset are mutually exclusive (overdue requires daysUntilDue < 0, a matched offset
 * requires daysUntilDue === offset >= 0) — so every due item resolves to at most one outcome. */
function outcomeFor(item: { matchedOffsets: number[]; isOverdue: boolean }): Outcome | null {
  if (item.isOverdue) return { kind: "overdue" };
  if (item.matchedOffsets.length > 0) return { kind: "before", offset: item.matchedOffsets[0]! };
  return null;
}

function severityFor(outcome: Outcome): "INFO" | "WARNING" | "URGENT" {
  if (outcome.kind === "overdue") return "URGENT";
  return outcome.offset <= 1 ? "WARNING" : "INFO";
}

function idempotencyKey(prefix: "bill_occ" | "settlement", id: string, outcome: Outcome, today: ISODate, userId: string): string {
  const middle = outcome.kind === "overdue" ? `overdue:${today}` : `before:${outcome.offset}`;
  return `${prefix}:${id}:${middle}:user:${userId}`;
}

function billContent(item: DueBillOccurrence, outcome: Outcome): { title: string; body: string } {
  const amount = (item.amountDuePaise / 100).toFixed(2);
  if (outcome.kind === "overdue") {
    return { title: `${item.billName} overdue by ${-item.daysUntilDue} day(s)`, body: `₹${amount} was due on ${item.dueDate} and is still unpaid.` };
  }
  const title = outcome.offset === 0 ? `${item.billName} due today` : `${item.billName} due in ${outcome.offset} day(s)`;
  return { title, body: `₹${amount} is due on ${item.dueDate}.` };
}

function settlementContent(item: DueSettlement, outcome: Outcome): { title: string; body: string } {
  const amount = (item.netPayablePaise / 100).toFixed(2);
  if (outcome.kind === "overdue") {
    return { title: `${item.househelpName}'s salary overdue by ${-item.daysUntilDue} day(s)`, body: `₹${amount} was due on ${item.dueDate} and is still unpaid.` };
  }
  const title = outcome.offset === 0 ? `${item.househelpName}'s salary due today` : `${item.househelpName}'s salary due in ${outcome.offset} day(s)`;
  return { title, body: `₹${amount} is due on ${item.dueDate}.` };
}

type Recipient = { userId: string; channels: readonly NotificationChannelValue[] };

/** Every ACTIVE member of `householdId`, minus anyone whose `notification_preferences` row for
 * `category` has `enabled: false`. A missing preference row means "enabled, default channels" —
 * matches the column's own `enabled.default(true)` and the fact that invited members never get a
 * preferences row seeded (only the household creator does, in `household.service.ts`). */
async function getRecipients(deps: Deps, householdId: string, category: "BILL" | "SALARY"): Promise<Recipient[]> {
  const [members, prefs] = await Promise.all([
    deps.db.select({ userId: householdMembers.userId }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.status, "ACTIVE"))),
    deps.db.select().from(notificationPreferences)
      .where(and(eq(notificationPreferences.householdId, householdId), eq(notificationPreferences.category, category))),
  ]);
  const prefByUser = new Map(prefs.map((p) => [p.userId, p]));
  const recipients: Recipient[] = [];
  for (const m of members) {
    const pref = prefByUser.get(m.userId);
    if (pref && !pref.enabled) continue;
    recipients.push({ userId: m.userId, channels: pref?.channels ?? DEFAULT_CHANNELS });
  }
  return recipients;
}

type NotificationInput = {
  householdId: string; userId: string; category: "BILL" | "SALARY"; severity: "INFO" | "WARNING" | "URGENT";
  title: string; body: string; entityType: string; entityId: string; data: Record<string, unknown>;
  idempotencyKey: string; channels: readonly NotificationChannelValue[]; now: Date;
};

/** Inserts the notification + one delivery row per channel in a transaction. A unique-violation on
 * `notifications_idempotency_uq` (a re-run of the same hour, or a retried job) means this exact
 * notification already exists — caught and treated as success, not an error. */
async function createNotification(deps: Deps, input: NotificationInput): Promise<void> {
  try {
    await deps.db.transaction(async (tx) => {
      const [row] = await tx.insert(notifications).values({
        householdId: input.householdId, userId: input.userId, category: input.category, severity: input.severity,
        title: input.title, body: input.body, entityType: input.entityType, entityId: input.entityId,
        data: input.data, idempotencyKey: input.idempotencyKey,
      }).returning({ id: notifications.id });
      const notificationId = row!.id;
      for (const channel of input.channels) {
        await tx.insert(notificationDeliveries).values({
          householdId: input.householdId, notificationId, channel,
          status: channel === "IN_APP" ? "SENT" : "PENDING",
          sentAt: channel === "IN_APP" ? input.now : null,
        });
      }
    });
  } catch (err) {
    if (!isIdempotencyKeyViolation(err)) throw err;
  }
}

/** Hourly: for every non-archived household, evaluates due bill occurrences and salary settlements
 * against their effective reminder_rules, and creates a notification for every active member whose
 * preferences don't disable that category — gated per item by the effective rule's sendHour matching
 * the household's current local hour. In-app only: non-IN_APP deliveries are recorded PENDING for a
 * later spec's dispatcher. */
export async function runEvaluateReminders(deps: Deps): Promise<void> {
  const now = deps.clock.now();
  const allHouseholds = await deps.db.select({ id: households.id, timezone: households.timezone })
    .from(households).where(isNull(households.archivedAt));

  for (const household of allHouseholds) {
    try {
      const today = dateInZone(now, household.timezone);
      const hour = hourInZone(now, household.timezone);

      const [dueBills, dueSettlements] = await Promise.all([
        getDueBillOccurrences(deps, household.id, today),
        getDueSettlements(deps, household.id, today),
      ]);

      for (const item of dueBills) {
        const outcome = outcomeFor(item);
        if (!outcome || item.sendHour !== hour) continue;
        const { title, body } = billContent(item, outcome);
        const recipients = await getRecipients(deps, household.id, "BILL");
        for (const recipient of recipients) {
          await createNotification(deps, {
            householdId: household.id, userId: recipient.userId, category: "BILL", severity: severityFor(outcome),
            title, body, entityType: "bill_occurrence", entityId: item.occurrenceId,
            data: { amountDuePaise: item.amountDuePaise, dueDate: item.dueDate },
            idempotencyKey: idempotencyKey("bill_occ", item.occurrenceId, outcome, today, recipient.userId),
            channels: recipient.channels, now,
          });
        }
      }

      for (const item of dueSettlements) {
        const outcome = outcomeFor(item);
        if (!outcome || item.sendHour !== hour) continue;
        const { title, body } = settlementContent(item, outcome);
        const recipients = await getRecipients(deps, household.id, "SALARY");
        for (const recipient of recipients) {
          await createNotification(deps, {
            householdId: household.id, userId: recipient.userId, category: "SALARY", severity: severityFor(outcome),
            title, body, entityType: "salary_settlement", entityId: item.settlementId,
            data: { netPayablePaise: item.netPayablePaise, dueDate: item.dueDate },
            idempotencyKey: idempotencyKey("settlement", item.settlementId, outcome, today, recipient.userId),
            channels: recipient.channels, now,
          });
        }
      }
    } catch (err) {
      // One household's failure (a query blip, an unexpected data shape) must not abort every
      // household processed after it in this hourly tick — log and move on. A matched-offset
      // reminder is non-repeating (the offset won't match again on a retry an hour later), so an
      // uncaught error here could permanently drop it for that occurrence; a daily-overdue item
      // tries again tomorrow regardless.
      deps.logger.error({ err, householdId: household.id }, "evaluate-reminders failed for household");
    }
  }
}
