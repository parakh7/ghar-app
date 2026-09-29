import type { Logger } from "../../lib/logger.js";

export type EmailMessage = { to: string; subject: string; text: string; html?: string; tag: string };

/** Swap in SES / Resend / Postmark later without touching auth code. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/** Development: prints the email (including links) to the log. */
export class ConsoleEmailProvider implements EmailProvider {
  constructor(private readonly logger: Logger) {}
  async send(message: EmailMessage): Promise<void> {
    this.logger.info({ email: { to: message.to, subject: message.subject, tag: message.tag } }, `✉  ${message.subject}\n${message.text}`);
  }
}

/** Tests: keeps messages in memory so assertions can read links. */
export class MemoryEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
  last(tag?: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((m) => !tag || m.tag === tag);
  }
}
