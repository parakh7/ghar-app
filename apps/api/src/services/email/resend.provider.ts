import type { Resend } from "resend";
import type { Logger } from "../../lib/logger.js";
import type { EmailMessage, EmailProvider } from "./email.provider.js";

/**
 * Resend's SDK returns `{ data, error }` rather than throwing on API-level failures (bad API key,
 * invalid recipient, rate limit) — normalized to a thrown Error so every call site's existing
 * `.catch(err => logger.error(...))` pattern keeps working unchanged.
 */
export class ResendEmailProvider implements EmailProvider {
  constructor(private readonly client: Resend, private readonly from: string, private readonly logger: Logger) {}

  async send(message: EmailMessage): Promise<void> {
    const result = await this.client.emails.send({
      from: this.from, to: message.to, subject: message.subject,
      text: message.text, ...(message.html ? { html: message.html } : {}),
      tags: [{ name: "type", value: message.tag }],
    });
    if (result.error) throw new Error(`Resend send failed: ${result.error.message}`);
    this.logger.info({ email: { to: message.to, tag: message.tag, id: result.data.id } }, "email sent via Resend");
  }
}
