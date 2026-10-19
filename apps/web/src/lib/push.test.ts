import { afterEach, describe, expect, it, vi } from "vitest";
import { getPushSupportState, isPushSupported, PushPermissionDeniedError, subscribeToPush, unsubscribeFromPush } from "./push";

function stubSupport({ permission, subscription }: { permission: NotificationPermission; subscription: unknown }) {
  (window as unknown as { PushManager: unknown }).PushManager = class {};
  (window as unknown as { Notification: unknown }).Notification = {
    permission,
    requestPermission: vi.fn().mockResolvedValue(permission),
  };
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(subscription),
      subscribe: vi.fn().mockResolvedValue(
        subscription ?? { endpoint: "https://push.example/abc", toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }) },
      ),
    },
  };
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(registration) }, configurable: true });
  return registration;
}

function clearStubs() {
  delete (window as unknown as { PushManager?: unknown }).PushManager;
  delete (window as unknown as { Notification?: unknown }).Notification;
  Reflect.deleteProperty(navigator, "serviceWorker");
}

describe("push support helpers", () => {
  afterEach(() => { clearStubs(); vi.restoreAllMocks(); });

  it("reports unsupported when the browser lacks the push APIs", async () => {
    expect(isPushSupported()).toBe(false);
    expect(await getPushSupportState()).toBe("unsupported");
  });

  it("reports denied when Notification.permission is denied", async () => {
    stubSupport({ permission: "denied", subscription: null });
    expect(await getPushSupportState()).toBe("denied");
  });

  it("reports default when permission hasn't been requested yet", async () => {
    stubSupport({ permission: "default", subscription: null });
    expect(await getPushSupportState()).toBe("default");
  });

  it("reports granted-unsubscribed when permission is granted but no subscription exists", async () => {
    stubSupport({ permission: "granted", subscription: null });
    expect(await getPushSupportState()).toBe("granted-unsubscribed");
  });

  it("reports subscribed when an active subscription exists", async () => {
    stubSupport({ permission: "granted", subscription: { endpoint: "https://push.example/abc" } });
    expect(await getPushSupportState()).toBe("subscribed");
  });

  it("subscribes and returns the subscription JSON when permission is granted", async () => {
    const registration = stubSupport({ permission: "granted", subscription: null });
    const result = await subscribeToPush("B".repeat(87));
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(result.endpoint).toBe("https://push.example/abc");
  });

  it("throws PushPermissionDeniedError when the user denies the prompt", async () => {
    stubSupport({ permission: "denied", subscription: null });
    (window as unknown as { Notification: { requestPermission: () => Promise<NotificationPermission> } }).Notification.requestPermission = vi.fn().mockResolvedValue("denied");
    await expect(subscribeToPush("B".repeat(87))).rejects.toBeInstanceOf(PushPermissionDeniedError);
  });

  it("unsubscribes the active subscription and returns its endpoint", async () => {
    const existing = { endpoint: "https://push.example/abc", unsubscribe: vi.fn().mockResolvedValue(true) };
    stubSupport({ permission: "granted", subscription: existing });
    const endpoint = await unsubscribeFromPush();
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(endpoint).toBe("https://push.example/abc");
  });

  it("returns null from unsubscribe when there's no active subscription", async () => {
    stubSupport({ permission: "granted", subscription: null });
    expect(await unsubscribeFromPush()).toBeNull();
  });
});
