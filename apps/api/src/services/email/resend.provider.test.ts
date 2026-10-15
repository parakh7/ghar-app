import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../lib/logger.js";
import { ResendEmailProvider } from "./resend.provider.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function fakeResend(send: (payload: unknown) => Promise<unknown>) {
  return { emails: { send } } as unknown as import("resend").Resend;
}

describe("ResendEmailProvider", () => {
  it("maps the message fields and sends via the Resend client", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "email_123" }, error: null });
    const logger = fakeLogger();
    const provider = new ResendEmailProvider(fakeResend(send), "Ghar <onboarding@resend.dev>", logger);

    await provider.send({ to: "parakh@example.com", subject: "Confirm your email", text: "hi", tag: "verify-email" });

    expect(send).toHaveBeenCalledWith({
      from: "Ghar <onboarding@resend.dev>", to: "parakh@example.com", subject: "Confirm your email",
      text: "hi", tags: [{ name: "type", value: "verify-email" }],
    });
    expect(logger.info).toHaveBeenCalledWith(
      { email: { to: "parakh@example.com", tag: "verify-email", id: "email_123" } },
      "email sent via Resend",
    );
  });

  it("includes html only when the message provides it", async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: "email_1" }, error: null });
    const provider = new ResendEmailProvider(fakeResend(send), "from@example.com", fakeLogger());

    await provider.send({ to: "a@example.com", subject: "s", text: "t", html: "<p>t</p>", tag: "household-invite" });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ html: "<p>t</p>" }));
  });

  it("throws when Resend returns an error, so the caller's .catch handles it", async () => {
    const send = vi.fn().mockResolvedValue({ data: null, error: { message: "Invalid `from` field", statusCode: 422, name: "invalid_from_address" } });
    const provider = new ResendEmailProvider(fakeResend(send), "bad-from", fakeLogger());

    await expect(provider.send({ to: "a@example.com", subject: "s", text: "t", tag: "reset-password" }))
      .rejects.toThrow("Resend send failed: Invalid `from` field");
  });
});
