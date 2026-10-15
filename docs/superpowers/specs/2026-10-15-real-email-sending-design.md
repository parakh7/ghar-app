# Real Email Sending (Resend) — Design Spec

**Status:** Approved.

## Context

`apps/api/src/services/email/email.provider.ts` defines an `EmailProvider` interface
(`send(message: EmailMessage): Promise<void>`) with two implementations: `ConsoleEmailProvider`
(logs the email to the server's own log output — the current dev default) and `MemoryEmailProvider`
(test-only, keeps sent messages in memory for assertions). There is no real email delivery anywhere
in the app. This was surfaced by the household-invite flow: clicking "Send invite" calls
`deps.email.send(...)`, which only ever logs to the API server's console — no actual email reaches
the invited person.

The same `EmailProvider`/`deps.email.send()` call is shared by four flows, all in
`apps/api/src/services/email/templates.ts`: `verifyEmailMessage` (signup), `resetPasswordMessage`,
`passwordChangedMessage`, and `inviteMessage`. Implementing a real provider turns on real delivery
for all four — there's no reason to special-case invites, since it's the same interface.

## Provider: Resend

Chosen for its free tier (3,000 emails/month) and simple API — a good fit for a personal household
app with no existing email infrastructure. Starting from scratch (no Resend account yet), so this
ships using Resend's **sandbox sender** (`onboarding@resend.dev`), which works immediately with
just an API key and needs no domain verification.

**Known sandbox limitation:** without a verified domain, Resend can only deliver to the email
address used to sign up for the Resend account itself — not to arbitrary invite recipients. This
is a Resend account-level restriction, not something this implementation can route around. The
code ships ready for real third-party delivery the moment a domain is verified (`EMAIL_FROM`
changes to an address on that domain — no code change needed). This limitation gets called out in
`.env.example` and the README, not silently hidden.

## Implementation

**New file** `apps/api/src/services/email/resend.provider.ts`:
```ts
import { Resend } from "resend";
import type { Logger } from "../../lib/logger.js";
import type { EmailMessage, EmailProvider } from "./email.provider.js";

export class ResendEmailProvider implements EmailProvider {
  constructor(private readonly client: Resend, private readonly from: string, private readonly logger: Logger) {}

  async send(message: EmailMessage): Promise<void> {
    const result = await this.client.emails.send({
      from: this.from, to: message.to, subject: message.subject,
      text: message.text, ...(message.html ? { html: message.html } : {}),
      tags: [{ name: "type", value: message.tag }],
    });
    if (result.error) throw new Error(`Resend send failed: ${result.error.message}`);
    this.logger.info({ email: { to: message.to, tag: message.tag, id: result.data?.id } }, "email sent via Resend");
  }
}
```

- `EmailMessage`'s `tag` field (e.g. `"household-invite"`, `"verify-email"`) maps to Resend's
  `tags: [{ name, value }]` metadata — visible in the Resend dashboard for filtering/debugging,
  doesn't change delivery behavior.
- Resend's SDK returns `{ data, error }` rather than throwing on API-level failures (bad API key,
  invalid recipient, rate limit) — normalized to a thrown `Error` so every call site's existing
  `.catch(err => logger.error(...))` pattern keeps working unchanged.

**Config** (`apps/api/src/config/env.ts`):
- `EMAIL_PROVIDER: z.enum(["console", "memory", "resend"])` (was `["console", "memory"]`).
- New `RESEND_API_KEY: z.string().optional()`, validated via `superRefine`: required (non-empty)
  when `EMAIL_PROVIDER === "resend"`, same pattern as the existing production `EMAIL_FROM` guard.
- `EMAIL_FROM` is reused as-is — no schema change. Sandbox mode requires it to literally be
  `onboarding@resend.dev`; documented in `.env.example`, not enforced in code (so swapping in a
  verified domain's address later needs zero code changes).

**Wiring** (`apps/api/src/server.ts`): the existing
`env.EMAIL_PROVIDER === "memory" ? new MemoryEmailProvider() : new ConsoleEmailProvider(logger)`
ternary becomes a switch adding the `resend` case, constructing
`new ResendEmailProvider(new Resend(env.RESEND_API_KEY!), env.EMAIL_FROM, logger)`.

**Dependency:** adds `resend` (official npm SDK) to `apps/api/package.json`.

## Error handling

Unchanged from today: every call site already does
`deps.email.send(...).catch(err => deps.logger.error({ err, ... }, "... email failed"))` — fire-and-
forget, never blocks the signup/invite/reset-password response. A Resend outage or misconfigured
API key degrades to "the email didn't send, logged as an error" rather than breaking those flows.

## Testing

New `apps/api/src/services/email/resend.provider.test.ts`: mocks the `resend` package
(`vi.mock("resend")`) to verify `ResendEmailProvider`:
- calls `emails.send` with the correctly mapped fields (from/to/subject/text/tags, and html only
  when present),
- throws when Resend returns `{ error }`, so the caller's existing `.catch` fires,
- logs success with the returned message id when `{ data }` is returned.

No changes to `ConsoleEmailProvider`/`MemoryEmailProvider` or any existing test — `EMAIL_PROVIDER`
defaults to `"console"` in dev and the test suite already pins `"memory"`, so this is additive.

## Out of scope

- Email templates/branding (HTML versions, logo, styled layout) — today's plain-text templates are
  unchanged; only the delivery mechanism changes.
- Domain verification itself (a Resend dashboard/DNS task for the user, not code).
- Retry/queue logic for failed sends — matches the existing fire-and-forget behavior; a failed send
  is logged, not retried.
