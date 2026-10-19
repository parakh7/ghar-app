import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../lib/logger.js";
import { PushSendError } from "./push.provider.js";
import { WebPushProvider } from "./web-push.provider.js";

const { setVapidDetails, sendNotification } = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("web-push", () => ({ default: { setVapidDetails, sendNotification } }));

function fakeLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("WebPushProvider", () => {
  beforeEach(() => {
    setVapidDetails.mockClear();
    sendNotification.mockClear();
  });

  it("sets VAPID details once at construction", () => {
    new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    expect(setVapidDetails).toHaveBeenCalledWith("mailto:a@example.com", "pub", "priv");
  });

  it("sends the subscription and JSON payload via web-push", async () => {
    sendNotification.mockResolvedValue(undefined);
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await provider.send({ endpoint: "https://push.example/abc", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "reminder-notification", linkPath: "/bills/1" });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
      JSON.stringify({ title: "t", body: "b", tag: "reminder-notification", linkPath: "/bills/1" }),
    );
  });

  it("throws PushSendError when web-push rejects with statusCode 410", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }));
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await expect(provider.send({ endpoint: "e", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "x", linkPath: null }))
      .rejects.toBeInstanceOf(PushSendError);
  });

  it("throws PushSendError when web-push rejects with statusCode 404", async () => {
    sendNotification.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await expect(provider.send({ endpoint: "e", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "x", linkPath: null }))
      .rejects.toBeInstanceOf(PushSendError);
  });

  it("passes through other errors unchanged", async () => {
    sendNotification.mockRejectedValue(new Error("network down"));
    const provider = new WebPushProvider("pub", "priv", "mailto:a@example.com", fakeLogger());
    await expect(provider.send({ endpoint: "e", p256dh: "p", auth: "a" }, { title: "t", body: "b", tag: "x", linkPath: null }))
      .rejects.toThrow("network down");
  });
});
