# Members & Invites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a household OWNER (by default) invite people by email, manage member roles, remove members, and let any member leave — on top of Phase 1's existing schema and authorization.

**Architecture:** New `member.service.ts` (API) mirrors the existing `household.service.ts` style (plain functions taking `Deps`/`DbOrTx`, no classes). New routes are added to the existing `household.routes.ts` (household-scoped: members, invites) and one new `invite.routes.ts` (the accept endpoint, which isn't household-scoped since the caller isn't a member yet). The web app gets a new `features/app/members/` folder plus small, targeted edits to `App.tsx`, `MorePage.tsx`, `SignInPage.tsx`, and `SignUpPage.tsx` so the invite-accept redirect chain works for both existing and brand-new accounts.

**Tech Stack:** Express 5, Drizzle ORM, zod 4, Vitest + Supertest (API, real Postgres), React 19 + TanStack Query + React Router 7, Vitest + Testing Library (web).

## Global Constraints

- TypeScript strict mode, `noUncheckedIndexedAccess` — non-null assertions (`row!`) only where a prior check or `.returning()` guarantees the row exists, matching existing code (e.g. `household.service.ts`).
- Business logic lives in `apps/api/src/services/*`; routes only parse input, call a service, and respond (`ok`/throw `AppError`).
- Validation schemas live once in `packages/shared/src/schemas.ts` and are used by both API (`parseBody`) and web (client-side `safeParse` before submit).
- Every household-scoped route goes through `requireHousehold(deps, permission)`; downstream code uses `req.membership.householdId`, never the raw URL param. Non-members get 404, not 403.
- Every audit-logged mutation writes its `audit_logs` row inside the same transaction as the change, via `recordAudit(tx, entry)`.
- No new `ErrorCode` values — this feature only needs codes that already exist: `VALIDATION_ERROR`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INVALID_TOKEN`, `UNAUTHENTICATED`.
- Money/date conventions from Phase 1 don't apply here (no currency or calendar fields in this spec).
- API integration tests run against a real Postgres (`TEST_DATABASE_URL`), truncated per test via `truncateAll`, following the existing `apps/api/tests/households.test.ts` pattern exactly (same helpers file, same `createTestContext`/`signupUser`/`csrf` helpers).
- Web component tests follow `apps/web/src/features/auth/SignInPage.test.tsx`'s pattern: mock `globalThis.fetch`, wrap in `QueryClientProvider` + `MemoryRouter`.
- Spec: `docs/superpowers/specs/2026-09-29-members-invites-design.md`.

---

### Task 1: Shared schemas and DTOs

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/dto.ts`

**Interfaces:**
- Produces: `inviteMemberSchema`, `updateMemberSchema`, `acceptInviteSchema` (zod schemas) and `InviteMemberInput`, `UpdateMemberInput`, `AcceptInviteInput` (inferred types) from `schemas.ts`; `MemberDTO`, `InviteDTO` (types) from `dto.ts`. All re-exported already via `packages/shared/src/index.ts` (`export * from "./schemas.js"` / `"./dto.js"` — no change needed there).

- [ ] **Step 1: Add the three new zod schemas to `schemas.ts`**

Add at the end of `packages/shared/src/schemas.ts`:

```ts
export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});
export const updateMemberSchema = z.object({
  role: z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]).optional(),
  displayName: z.string().trim().max(40).optional(),
}).refine((v) => v.role !== undefined || v.displayName !== undefined, { message: "Provide a role or display name to update." });
export const acceptInviteSchema = z.object({ token: z.string().min(20).max(200) });

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
```

Invite role excludes `OWNER` deliberately — you can't invite a second owner directly; an existing OWNER can promote someone via `updateMemberSchema` after they've joined.

- [ ] **Step 2: Add the two new DTOs to `dto.ts`**

Add at the end of `packages/shared/src/dto.ts` (it already imports `HouseholdRole` at the top — reuse that import):

```ts
export type MemberDTO = { userId: string; name: string; email: string; role: HouseholdRole; displayName: string | null; joinedAt: string };
export type InviteDTO = { id: string; email: string; role: HouseholdRole; expiresAt: string; createdAt: string };
```

- [ ] **Step 3: Build and typecheck the shared package**

Run: `npm run build -w @household/shared && npm run typecheck -w @household/shared`
Expected: both succeed with no errors (this package has no test file for `schemas.ts`/`dto.ts` today — same as Phase 1's pattern — so build + typecheck is the verification here).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/schemas.ts packages/shared/src/dto.ts
git commit -m "feat(shared): add member and invite schemas/DTOs"
```

---

### Task 2: Member management — API (list, role change, removal, self-leave)

**Files:**
- Create: `apps/api/src/services/member.service.ts`
- Modify: `apps/api/src/routes/household.routes.ts`
- Test: `apps/api/tests/members.test.ts` (new file — this task writes the "listing and managing members" section; Task 3 appends the "invites" section to the same file)

**Interfaces:**
- Consumes: `Deps` (`apps/api/src/services/deps.ts`), `DbOrTx` (`apps/api/src/db/client.ts`), `Membership` type + `getMembership`/`getHousehold` (`apps/api/src/services/household.service.ts`), `recordAudit` (`apps/api/src/services/audit.service.ts`), `Errors` (`apps/api/src/lib/errors.ts`), `requireHousehold` (`apps/api/src/middleware/household.ts`), `parseBody` (`apps/api/src/middleware/validate.ts`), `ok` (`apps/api/src/lib/respond.ts`), `MemberDTO`/`UpdateMemberInput`/`HouseholdRole` (`@household/shared`), `householdMembers`/`users` tables (`apps/api/src/db/schema.ts`).
- Produces: `listMembers(db, householdId): Promise<MemberDTO[]>`, `updateMember(deps, actorUserId, membership, targetUserId, patch, ip?): Promise<MemberDTO>`, `removeMember(deps, actorUserId, membership, targetUserId, ip?): Promise<void>`, `leaveHousehold(deps, membership, userId, ip?): Promise<void>` — all from `member.service.ts`. Task 3 and Task 4 import these names.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/tests/members.test.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, signupUser, truncateAll, type TestContext } from "./helpers.js";

const ctx = createTestContext();
beforeEach(() => truncateAll(ctx.db));
afterAll(() => ctx.close());

async function createHousehold(c: TestContext, cookie: string, name = "Shah Family") {
  const res = await c.request.post("/api/households").set(csrf).set("cookie", cookie).send({ name });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function addMember(householdId: string, userId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER") {
  await ctx.db.insert(householdMembers).values({ householdId, userId, role, status: "ACTIVE", joinedAt: ctx.clock.now() });
}

describe("listing and managing members", () => {
  it("lists active members but not removed ones", async () => {
    const owner = await signupUser(ctx);
    const removed = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, removed.id, "MEMBER");
    await ctx.db.update(householdMembers).set({ status: "REMOVED" }).where(eq(householdMembers.userId, removed.id));
    const res = await ctx.request.get(`/api/households/${h.id}/members`).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { email: string }) => m.email)).toEqual([owner.email]);
  });

  it("VIEWER can view members but not change roles", async () => {
    const owner = await signupUser(ctx);
    const viewer = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, viewer.id, "VIEWER");
    expect((await ctx.request.get(`/api/households/${h.id}/members`).set("cookie", viewer.cookie)).status).toBe(200);
    const patch = await ctx.request.patch(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", viewer.cookie).send({ role: "MEMBER" });
    expect(patch.status).toBe(403);
  });

  it("OWNER can change a member's role and it is audited with old and new values", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.patch(`/api/households/${h.id}/members/${member.id}`).set(csrf).set("cookie", owner.cookie).send({ role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("ADMIN");
    const [log] = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.householdId, h.id), eq(auditLogs.action, "member.updated")));
    expect(log).toMatchObject({ actorUserId: owner.id, entityId: member.id, oldValue: { role: "MEMBER" }, newValue: { role: "ADMIN" } });
  });

  it("cannot demote the last owner", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.patch(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", owner.cookie).send({ role: "ADMIN" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("cannot remove the last owner", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.delete(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("can remove an owner once a second owner exists", async () => {
    const owner = await signupUser(ctx);
    const second = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, second.id, "OWNER");
    const res = await ctx.request.delete(`/api/households/${h.id}/members/${owner.id}`).set(csrf).set("cookie", second.cookie);
    expect(res.status).toBe(200);
  });

  it("OWNER can remove a member, who then loses access", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.delete(`/api/households/${h.id}/members/${member.id}`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(200);
    expect((await ctx.request.get(`/api/households/${h.id}`).set("cookie", member.cookie)).status).toBe(404);
  });

  it("a member can leave voluntarily", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.delete(`/api/households/${h.id}/members/me`).set(csrf).set("cookie", member.cookie);
    expect(res.status).toBe(200);
    expect((await ctx.request.get(`/api/households/${h.id}`).set("cookie", member.cookie)).status).toBe(404);
  });

  it("the last owner cannot leave", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const res = await ctx.request.delete(`/api/households/${h.id}/members/me`).set(csrf).set("cookie", owner.cookie);
    expect(res.status).toBe(400);
  });

  it("a member of household A cannot list or manage members of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    const a = await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    expect((await ctx.request.get(`/api/households/${b.id}/members`).set("cookie", alice.cookie)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- members.test.ts`
Expected: FAIL — `/api/households/:id/members` routes don't exist yet (404s from the router's catch-all, or import errors since `member.service.ts` doesn't exist).

- [ ] **Step 3: Implement `member.service.ts`**

Create `apps/api/src/services/member.service.ts`:

```ts
import { and, asc, count, eq } from "drizzle-orm";
import type { HouseholdRole, MemberDTO, UpdateMemberInput } from "@household/shared";
import { householdMembers, users } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import type { Membership } from "./household.service.js";

const MEMBER_SELECT = {
  userId: users.id, name: users.name, email: users.email,
  role: householdMembers.role, displayName: householdMembers.displayName, joinedAt: householdMembers.joinedAt,
} as const;

function toMemberDTO(row: { userId: string; name: string; email: string; role: HouseholdRole; displayName: string | null; joinedAt: Date | null }): MemberDTO {
  // ACTIVE rows always have joinedAt set — it's stamped when a row becomes ACTIVE (invite accept or direct add).
  return { ...row, joinedAt: row.joinedAt!.toISOString() };
}

export async function listMembers(db: DbOrTx, householdId: string): Promise<MemberDTO[]> {
  const rows = await db.select(MEMBER_SELECT).from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.status, "ACTIVE")))
    .orderBy(asc(householdMembers.createdAt));
  return rows.map(toMemberDTO);
}

async function getMemberDTO(db: DbOrTx, householdId: string, userId: string): Promise<MemberDTO | undefined> {
  const [row] = await db.select(MEMBER_SELECT).from(householdMembers)
    .innerJoin(users, eq(users.id, householdMembers.userId))
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId), eq(householdMembers.status, "ACTIVE")))
    .limit(1);
  return row ? toMemberDTO(row) : undefined;
}

/** Counts ACTIVE owners. Pass a transaction and lock the target row first so this can't race a concurrent demotion/removal. */
async function countActiveOwners(tx: DbOrTx, householdId: string): Promise<number> {
  const [row] = await tx.select({ n: count() }).from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.role, "OWNER"), eq(householdMembers.status, "ACTIVE")));
  return Number(row?.n ?? 0);
}

const LAST_OWNER_ERROR = "A household needs at least one owner.";

export async function updateMember(
  deps: Deps, actorUserId: string, membership: Membership, targetUserId: string, patch: UpdateMemberInput, ip?: string,
): Promise<MemberDTO> {
  await deps.db.transaction(async (tx) => {
    const [before] = await tx.select({ role: householdMembers.role, displayName: householdMembers.displayName })
      .from(householdMembers)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId), eq(householdMembers.status, "ACTIVE")))
      .for("update");
    if (!before) throw Errors.notFound("Member");
    if (patch.role && before.role === "OWNER" && patch.role !== "OWNER" && (await countActiveOwners(tx, membership.householdId)) <= 1) {
      throw Errors.validation({ role: LAST_OWNER_ERROR });
    }
    const changes: Partial<{ role: HouseholdRole; displayName: string }> = {};
    if (patch.role !== undefined) changes.role = patch.role;
    if (patch.displayName !== undefined) changes.displayName = patch.displayName;
    await tx.update(householdMembers).set(changes)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId)));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.updated", entityType: "household_member", entityId: targetUserId, oldValue: before, newValue: changes, ipAddress: ip ?? null });
  });
  return (await getMemberDTO(deps.db, membership.householdId, targetUserId))!;
}

export async function removeMember(deps: Deps, actorUserId: string, membership: Membership, targetUserId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ role: householdMembers.role }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId), eq(householdMembers.status, "ACTIVE")))
      .for("update");
    if (!row) throw Errors.notFound("Member");
    if (row.role === "OWNER" && (await countActiveOwners(tx, membership.householdId)) <= 1) throw Errors.validation({ role: LAST_OWNER_ERROR });
    await tx.update(householdMembers).set({ status: "REMOVED" })
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, targetUserId)));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.removed", entityType: "household_member", entityId: targetUserId, ipAddress: ip ?? null });
  });
}

export async function leaveHousehold(deps: Deps, membership: Membership, userId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ role: householdMembers.role }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, userId), eq(householdMembers.status, "ACTIVE")))
      .for("update");
    if (!row) throw Errors.notFound("Membership");
    if (row.role === "OWNER" && (await countActiveOwners(tx, membership.householdId)) <= 1) {
      throw Errors.validation({}, "You're the only owner. Promote another member to owner before leaving.");
    }
    await tx.update(householdMembers).set({ status: "REMOVED" })
      .where(and(eq(householdMembers.householdId, membership.householdId), eq(householdMembers.userId, userId)));
    await recordAudit(tx, { householdId: membership.householdId, actorUserId: userId, action: "member.left", entityType: "household_member", entityId: userId, ipAddress: ip ?? null });
  });
}
```

- [ ] **Step 4: Wire the member routes into `household.routes.ts`**

Modify `apps/api/src/routes/household.routes.ts` — add the `updateMemberSchema` import and three routes. The `/members/me` route **must** be registered before `/members/:userId`, since Express would otherwise match the literal `me` as a `:userId` param on whichever route is registered first:

```ts
import { Router } from "express";
import { createHouseholdSchema, updateHouseholdSchema, updateMemberSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireHousehold } from "../middleware/household.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import type { Deps } from "../services/deps.js";
import * as households from "../services/household.service.js";
import * as members from "../services/member.service.js";
```

Add these routes after the existing `PATCH "/:householdId"` route and before `return r;`:

```ts
  r.get("/:householdId/members", requireHousehold(deps, "members.view"), async (req, res) => {
    ok(res, await members.listMembers(deps.db, req.membership!.householdId));
  });

  // Self-leave is gated on membership only, not members.manage — "members.view" is the closest
  // permission every ACTIVE role has by default, so this reuses requireHousehold rather than a new gate.
  r.delete("/:householdId/members/me", requireHousehold(deps, "members.view"), async (req, res) => {
    await members.leaveHousehold(deps, req.membership!, req.auth!.user.id, req.ip);
    ok(res, null, 200, "You've left the household.");
  });

  r.patch("/:householdId/members/:userId", requireHousehold(deps, "members.manage"), async (req, res) => {
    const patch = parseBody(req, updateMemberSchema);
    ok(res, await members.updateMember(deps, req.auth!.user.id, req.membership!, req.params.userId!, patch, req.ip), 200, "Member updated.");
  });

  r.delete("/:householdId/members/:userId", requireHousehold(deps, "members.manage"), async (req, res) => {
    await members.removeMember(deps, req.auth!.user.id, req.membership!, req.params.userId!, req.ip);
    ok(res, null, 200, "Member removed.");
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- members.test.ts`
Expected: PASS — all 9 cases in the "listing and managing members" describe block.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/member.service.ts apps/api/src/routes/household.routes.ts apps/api/tests/members.test.ts
git commit -m "feat(api): member listing, role changes, removal and self-leave"
```

---

### Task 3: Invites — API (create, accept, revoke, resend)

**Files:**
- Modify: `apps/api/src/services/member.service.ts` (append invite functions)
- Modify: `apps/api/src/services/email/templates.ts` (append `inviteMessage`)
- Modify: `apps/api/src/routes/household.routes.ts` (append invite routes)
- Create: `apps/api/src/routes/invite.routes.ts`
- Modify: `apps/api/src/app.ts` (mount `invite.routes.ts`)
- Test: `apps/api/tests/members.test.ts` (append the "invites" describe block)

**Interfaces:**
- Consumes: everything Task 2 produced, plus `generateToken`/`hashToken` (`apps/api/src/lib/crypto.ts`), `getMembership`/`getHousehold` (`household.service.ts`), `tokenFromLink`/`DAY` (`apps/api/tests/helpers.ts`, already exist).
- Produces: `listInvites(deps, householdId): Promise<InviteDTO[]>`, `createInvite(deps, actorUserId, membership, input, ip?): Promise<InviteDTO>`, `revokeInvite(deps, actorUserId, householdId, inviteId, ip?): Promise<void>`, `resendInvite(deps, actorUserId, membership, inviteId, ip?): Promise<InviteDTO>`, `acceptInvite(deps, user, token, ip?): Promise<HouseholdDTO>` (all from `member.service.ts`) — Task 5 (web) calls these indirectly via the routes this task adds.

- [ ] **Step 1: Write the failing integration tests**

Append to `apps/api/tests/members.test.ts` (same file as Task 2; add these imports to the top alongside the existing ones — `householdInvites` from schema, and `DAY`/`tokenFromLink` from helpers):

```ts
// add to the existing imports at the top of the file:
// import { auditLogs, householdInvites, householdMembers } from "../src/db/schema.js";
// import { createTestContext, csrf, DAY, signupUser, tokenFromLink, truncateAll, type TestContext } from "./helpers.js";

describe("invites", () => {
  it("creates an invite, emails a link, and the invitee accepts it", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    const create = await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "helper@example.com", role: "MEMBER" });
    expect(create.status).toBe(201);
    const invitee = await signupUser(ctx, { email: "helper@example.com" });
    const email = ctx.email.last("household-invite");
    expect(email?.to).toBe("helper@example.com");
    const token = tokenFromLink(email!.text);
    const accept = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(accept.status).toBe(200);
    expect(accept.body.data.id).toBe(h.id);
    const list = await ctx.request.get(`/api/households/${h.id}/members`).set("cookie", owner.cookie);
    expect(list.body.data.find((m: { email: string }) => m.email === "helper@example.com").role).toBe("MEMBER");
  });

  it("lets an existing account accept an invite for an email it already owns", async () => {
    const owner = await signupUser(ctx);
    const invitee = await signupUser(ctx, { email: "existing@example.com" });
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "existing@example.com", role: "VIEWER" });
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    const accept = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(accept.status).toBe(200);
  });

  it("rejects acceptance by a signed-in user whose email does not match the invite", async () => {
    const owner = await signupUser(ctx);
    const stranger = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "someone@example.com", role: "MEMBER" });
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", stranger.cookie).send({ token });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("someone@example.com");
  });

  it("rejects an expired invite", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "late@example.com", role: "MEMBER" });
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    ctx.clock.advance(8 * DAY);
    const invitee = await signupUser(ctx, { email: "late@example.com" });
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("rejects a revoked invite", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "gone@example.com", role: "MEMBER" });
    const [invite] = await ctx.db.select().from(householdInvites).where(eq(householdInvites.email, "gone@example.com"));
    await ctx.request.delete(`/api/households/${h.id}/invites/${invite!.id}`).set(csrf).set("cookie", owner.cookie);
    const token = tokenFromLink(ctx.email.last("household-invite")!.text);
    const invitee = await signupUser(ctx, { email: "gone@example.com" });
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token });
    expect(res.status).toBe(400);
  });

  it("resending an invite issues a new token that invalidates the old one", async () => {
    const owner = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "resend@example.com", role: "MEMBER" });
    const [invite] = await ctx.db.select().from(householdInvites).where(eq(householdInvites.email, "resend@example.com"));
    const oldToken = tokenFromLink(ctx.email.last("household-invite")!.text);
    await ctx.request.post(`/api/households/${h.id}/invites/${invite!.id}/resend`).set(csrf).set("cookie", owner.cookie);
    const newToken = tokenFromLink(ctx.email.last("household-invite")!.text);
    const invitee = await signupUser(ctx, { email: "resend@example.com" });
    const oldAttempt = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token: oldToken });
    expect(oldAttempt.status).toBe(400);
    const newAttempt = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", invitee.cookie).send({ token: newToken });
    expect(newAttempt.status).toBe(200);
  });

  it("rejects inviting an email that is already an active member", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx, { email: "already@example.com" });
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", owner.cookie).send({ email: "already@example.com", role: "MEMBER" });
    expect(res.status).toBe(409);
  });

  it("MEMBER cannot create invites", async () => {
    const owner = await signupUser(ctx);
    const member = await signupUser(ctx);
    const h = await createHousehold(ctx, owner.cookie);
    await addMember(h.id, member.id, "MEMBER");
    const res = await ctx.request.post(`/api/households/${h.id}/invites`).set(csrf).set("cookie", member.cookie).send({ email: "x@example.com", role: "MEMBER" });
    expect(res.status).toBe(403);
  });

  it("returns the generic invalid-token error for an unknown token (no enumeration)", async () => {
    const u = await signupUser(ctx);
    const res = await ctx.request.post("/api/invites/accept").set(csrf).set("cookie", u.cookie).send({ token: "not-a-real-token-not-a-real-token" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TOKEN");
  });

  it("requires authentication to accept an invite", async () => {
    const res = await ctx.request.post("/api/invites/accept").set(csrf).send({ token: "whatever-whatever-whatever12" });
    expect(res.status).toBe(401);
  });

  it("a member of household A cannot manage invites of household B", async () => {
    const alice = await signupUser(ctx);
    const bob = await signupUser(ctx);
    await createHousehold(ctx, alice.cookie, "A");
    const b = await createHousehold(ctx, bob.cookie, "B");
    const res = await ctx.request.post(`/api/households/${b.id}/invites`).set(csrf).set("cookie", alice.cookie).send({ email: "x@example.com", role: "MEMBER" });
    expect(res.status).toBe(404);
  });
});
```

Update the file's top-level import lines to:

```ts
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, householdInvites, householdMembers } from "../src/db/schema.js";
import { createTestContext, csrf, DAY, signupUser, tokenFromLink, truncateAll, type TestContext } from "./helpers.js";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace @household/api -- members.test.ts`
Expected: FAIL on every case in the new "invites" block (routes don't exist).

- [ ] **Step 3: Add the invite email template**

Append to `apps/api/src/services/email/templates.ts`:

```ts
export function inviteMessage(to: string, role: string, householdName: string, link: string): EmailMessage {
  return {
    to, tag: "household-invite", subject: `You're invited to join ${householdName} on Ghar`,
    text: `Hi,\n\n${householdName} would like you to join as a ${role.toLowerCase()} on Ghar, the household manager.\n\nAccept the invite:\n${link}\n\nThis link expires in 7 days. If you weren't expecting this, you can ignore this email.`,
  };
}
```

- [ ] **Step 4: Append invite functions to `member.service.ts`**

Replace the entire import block at the top of `apps/api/src/services/member.service.ts` (the one Task 2 wrote) with this complete, merged block — it keeps every name Task 2's code needs (`DbOrTx`, `Errors`, `recordAudit`, `Deps`, `Membership`, `HouseholdRole`, `and`/`asc`/`count`/`eq`) and adds what Task 3's new functions need (`gt`, `isNull`, `householdInvites`, `HouseholdDTO`/`InviteDTO`/`InviteMemberInput`, `generateToken`/`hashToken`, `getHousehold`/`getMembership`, `inviteMessage`):

```ts
import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import type { HouseholdDTO, HouseholdRole, InviteDTO, InviteMemberInput, MemberDTO, UpdateMemberInput } from "@household/shared";
import { householdInvites, householdMembers, users } from "../db/schema.js";
import type { DbOrTx } from "../db/client.js";
import { generateToken, hashToken } from "../lib/crypto.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "./audit.service.js";
import type { Deps } from "./deps.js";
import { getHousehold, getMembership, type Membership } from "./household.service.js";
import { inviteMessage } from "./email/templates.js";
```

Append at the end of `member.service.ts`:

```ts
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function toInviteDTO(row: { id: string; email: string; role: HouseholdRole; expiresAt: Date; createdAt: Date }): InviteDTO {
  return { id: row.id, email: row.email, role: row.role, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() };
}

export async function listInvites(deps: Deps, householdId: string): Promise<InviteDTO[]> {
  const rows = await deps.db.select().from(householdInvites)
    .where(and(eq(householdInvites.householdId, householdId), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt), gt(householdInvites.expiresAt, deps.clock.now())))
    .orderBy(asc(householdInvites.createdAt));
  return rows.map(toInviteDTO);
}

export async function createInvite(deps: Deps, actorUserId: string, membership: Membership, input: InviteMemberInput, ip?: string): Promise<InviteDTO> {
  const [existingMember] = await deps.db.select({ id: users.id }).from(users)
    .innerJoin(householdMembers, and(eq(householdMembers.userId, users.id), eq(householdMembers.householdId, membership.householdId), eq(householdMembers.status, "ACTIVE")))
    .where(eq(users.email, input.email)).limit(1);
  if (existingMember) throw Errors.conflict("This person is already a member of the household.");

  const token = generateToken();
  const now = deps.clock.now();
  const invite = await deps.db.transaction(async (tx) => {
    // Only the newest unaccepted invite for this email works — same "invalidate the old one" rule as auth tokens.
    await tx.update(householdInvites).set({ revokedAt: now })
      .where(and(eq(householdInvites.householdId, membership.householdId), eq(householdInvites.email, input.email), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt)));
    const [row] = await tx.insert(householdInvites).values({
      householdId: membership.householdId, email: input.email, role: input.role,
      tokenHash: hashToken(token), invitedByUserId: actorUserId, expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    }).returning();
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.invited", entityType: "household_invite", entityId: row!.id, newValue: { email: input.email, role: input.role }, ipAddress: ip ?? null });
    return row!;
  });
  const link = `${deps.env.APP_URL}/invites/accept?token=${encodeURIComponent(token)}&email=${encodeURIComponent(invite.email)}`;
  deps.email.send(inviteMessage(invite.email, invite.role, membership.name, link))
    .catch((err: unknown) => deps.logger.error({ err, householdId: membership.householdId }, "invite email failed"));
  deps.logger.info({ householdId: membership.householdId, event: "member.invited" }, "member invited");
  return toInviteDTO(invite);
}

export async function revokeInvite(deps: Deps, actorUserId: string, householdId: string, inviteId: string, ip?: string): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(householdInvites).set({ revokedAt: deps.clock.now() })
      .where(and(eq(householdInvites.id, inviteId), eq(householdInvites.householdId, householdId), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt)))
      .returning({ id: householdInvites.id });
    if (!row) throw Errors.notFound("Invite");
    await recordAudit(tx, { householdId, actorUserId, action: "member.invite_revoked", entityType: "household_invite", entityId: inviteId, ipAddress: ip ?? null });
  });
}

export async function resendInvite(deps: Deps, actorUserId: string, membership: Membership, inviteId: string, ip?: string): Promise<InviteDTO> {
  const token = generateToken();
  const now = deps.clock.now();
  const invite = await deps.db.transaction(async (tx) => {
    const [row] = await tx.update(householdInvites)
      .set({ tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + INVITE_TTL_MS) })
      .where(and(eq(householdInvites.id, inviteId), eq(householdInvites.householdId, membership.householdId), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt)))
      .returning();
    if (!row) throw Errors.notFound("Invite");
    await recordAudit(tx, { householdId: membership.householdId, actorUserId, action: "member.invite_resent", entityType: "household_invite", entityId: inviteId, ipAddress: ip ?? null });
    return row;
  });
  const link = `${deps.env.APP_URL}/invites/accept?token=${encodeURIComponent(token)}&email=${encodeURIComponent(invite.email)}`;
  deps.email.send(inviteMessage(invite.email, invite.role, membership.name, link))
    .catch((err: unknown) => deps.logger.error({ err, householdId: membership.householdId }, "invite email failed"));
  return toInviteDTO(invite);
}

/** `user` is whoever is currently authenticated — the caller doesn't need to be a member of the invite's household yet. */
export async function acceptInvite(deps: Deps, user: { id: string; email: string }, token: string, ip?: string): Promise<HouseholdDTO> {
  const now = deps.clock.now();
  const [invite] = await deps.db.select().from(householdInvites)
    .where(and(eq(householdInvites.tokenHash, hashToken(token)), isNull(householdInvites.acceptedAt), isNull(householdInvites.revokedAt), gt(householdInvites.expiresAt, now)))
    .limit(1);
  if (!invite) throw Errors.invalidToken();
  if (invite.email !== user.email) {
    throw Errors.forbidden(`This invite is for ${invite.email}. Sign out and sign in as that address to accept it.`);
  }
  await deps.db.transaction(async (tx) => {
    const [existing] = await tx.select({ status: householdMembers.status }).from(householdMembers)
      .where(and(eq(householdMembers.householdId, invite.householdId), eq(householdMembers.userId, user.id)))
      .for("update");
    if (existing) {
      await tx.update(householdMembers).set({ status: "ACTIVE", role: invite.role, joinedAt: now, invitedByUserId: invite.invitedByUserId })
        .where(and(eq(householdMembers.householdId, invite.householdId), eq(householdMembers.userId, user.id)));
    } else {
      await tx.insert(householdMembers).values({ householdId: invite.householdId, userId: user.id, role: invite.role, status: "ACTIVE", joinedAt: now, invitedByUserId: invite.invitedByUserId });
    }
    await tx.update(householdInvites).set({ acceptedAt: now }).where(eq(householdInvites.id, invite.id));
    await recordAudit(tx, { householdId: invite.householdId, actorUserId: user.id, action: "member.invite_accepted", entityType: "household_invite", entityId: invite.id, ipAddress: ip ?? null });
  });
  const membership = await getMembership(deps.db, user.id, invite.householdId);
  return getHousehold(deps.db, membership!);
}
```

- [ ] **Step 5: Add the invite routes to `household.routes.ts`**

Add `inviteMemberSchema` to the existing `@household/shared` import line, and append these routes before `return r;`, after the member routes from Task 2:

```ts
  r.get("/:householdId/invites", requireHousehold(deps, "members.manage"), async (req, res) => {
    ok(res, await members.listInvites(deps, req.membership!.householdId));
  });

  r.post("/:householdId/invites", requireHousehold(deps, "members.manage"), async (req, res) => {
    const input = parseBody(req, inviteMemberSchema);
    ok(res, await members.createInvite(deps, req.auth!.user.id, req.membership!, input, req.ip), 201, "Invite sent.");
  });

  r.delete("/:householdId/invites/:inviteId", requireHousehold(deps, "members.manage"), async (req, res) => {
    await members.revokeInvite(deps, req.auth!.user.id, req.membership!.householdId, req.params.inviteId!, req.ip);
    ok(res, null, 200, "Invite revoked.");
  });

  r.post("/:householdId/invites/:inviteId/resend", requireHousehold(deps, "members.manage"), async (req, res) => {
    ok(res, await members.resendInvite(deps, req.auth!.user.id, req.membership!, req.params.inviteId!, req.ip), 200, "Invite resent.");
  });
```

- [ ] **Step 6: Create the accept-invite route (not household-scoped)**

Create `apps/api/src/routes/invite.routes.ts`:

```ts
import { Router } from "express";
import { acceptInviteSchema } from "@household/shared";
import { requireAuth } from "../middleware/auth.js";
import { parseBody } from "../middleware/validate.js";
import { ok } from "../lib/respond.js";
import type { Deps } from "../services/deps.js";
import * as members from "../services/member.service.js";

/** Accepting an invite happens before the caller is a member, so this can't live behind requireHousehold. */
export function inviteRoutes(deps: Deps): Router {
  const r = Router();
  r.use(requireAuth);

  r.post("/accept", async (req, res) => {
    const { token } = parseBody(req, acceptInviteSchema);
    ok(res, await members.acceptInvite(deps, req.auth!.user, token, req.ip), 200, "You've joined the household.");
  });

  return r;
}
```

- [ ] **Step 7: Mount it in `app.ts`**

In `apps/api/src/app.ts`, add the import next to the other route imports:

```ts
import { inviteRoutes } from "./routes/invite.routes.js";
```

And add the mount line next to `app.use("/api/households", householdRoutes(deps));`:

```ts
  app.use("/api/invites", inviteRoutes(deps));
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test --workspace @household/api -- members.test.ts`
Expected: PASS — all cases in both describe blocks (Task 2's + Task 3's).

- [ ] **Step 9: Run the full API test suite to check for regressions**

Run: `npm run test --workspace @household/api`
Expected: PASS (Phase 1's `auth.test.ts`, `households.test.ts`, `security.test.ts` unaffected).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/services/member.service.ts apps/api/src/services/email/templates.ts apps/api/src/routes/household.routes.ts apps/api/src/routes/invite.routes.ts apps/api/src/app.ts apps/api/tests/members.test.ts
git commit -m "feat(api): email invites — create, accept, revoke, resend"
```

---

### Task 4: Web — members list, invite form, self-leave

**Files:**
- Modify: `apps/web/src/lib/api.ts` (add a `del` helper)
- Create: `apps/web/src/features/app/members/useMembers.ts`
- Create: `apps/web/src/features/app/members/MembersPage.tsx`
- Test: `apps/web/src/features/app/members/MembersPage.test.tsx`
- Modify: `apps/web/src/App.tsx` (add the `/members` route)
- Modify: `apps/web/src/features/app/MorePage.tsx` (add a link to Members, and a "Leave household" action)

**Interfaces:**
- Consumes: `get`/`post`/`patch` (`apps/web/src/lib/api.ts`), `ApiError` (same file), `MemberDTO`/`InviteDTO`/`HouseholdDTO`/`HouseholdRole`/`inviteMemberSchema` (`@household/shared`), `Alert`/`Button`/`TextField` (`apps/web/src/components/*`), `useActiveHousehold` (`apps/web/src/features/app/useActiveHousehold.ts`), `useFormErrors` (`apps/web/src/features/auth/useFormErrors.ts`), `zodFieldErrors` (`apps/web/src/features/auth/zod-errors.ts`), `meKey` (`apps/web/src/features/auth/session.ts`), CSS classes `page-head`/`page-title`/`section-title`/`list`/`list__item`/`list__label`/`list__meta`/`badge`/`badge--neutral` (already defined in `apps/web/src/features/app/shell.css`, loaded globally by `AppShell.tsx`).
- Produces: `del<T>(path): Promise<ApiResult<T>>` (`lib/api.ts`) — Task 5 uses it too. `useHousehold`, `useMembers`, `useInvites`, `useInviteMember`, `useRevokeInvite`, `useResendInvite`, `useUpdateMember`, `useRemoveMember`, `useLeaveHousehold` (`useMembers.ts`) — `useHousehold` is reused by Task 5's `MembersPage`-adjacent code if needed, but primarily consumed here.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/features/app/members/MembersPage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { meKey } from "../../auth/session";
import { MembersPage } from "./MembersPage";

const HOUSEHOLD = { id: "h1", name: "Shah Family", timezone: "Asia/Kolkata", role: "OWNER" as const, memberCount: 2 };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(meKey, { user: { id: "u1", name: "Parakh", email: "p@example.com", emailVerified: true, createdAt: "2026-01-01T00:00:00.000Z" }, households: [HOUSEHOLD] });
  return render(<QueryClientProvider client={qc}><MemoryRouter><MembersPage /></MemoryRouter></QueryClientProvider>);
}

function mockFetch(permissions: string[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/households/h1")) return jsonResponse({ success: true, data: { ...HOUSEHOLD, permissions }, message: null });
    if (url.endsWith("/households/h1/members")) return jsonResponse({ success: true, data: [{ userId: "u1", name: "Parakh", email: "p@example.com", role: "OWNER", displayName: null, joinedAt: "2026-01-01T00:00:00.000Z" }], message: null });
    if (url.endsWith("/households/h1/invites")) return jsonResponse({ success: true, data: [], message: null });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch);
}

describe("MembersPage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows members and the invite form when the viewer has members.manage", async () => {
    mockFetch(["members.view", "members.manage"]);
    renderPage();
    expect(await screen.findByText("p@example.com")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send invite" })).toBeInTheDocument();
  });

  it("hides the invite form and role editing for a viewer without members.manage", async () => {
    mockFetch(["members.view"]);
    renderPage();
    await screen.findByText("p@example.com");
    expect(screen.queryByRole("button", { name: "Send invite" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- MembersPage.test.tsx`
Expected: FAIL — `./MembersPage` doesn't exist yet.

- [ ] **Step 3: Add the `del` helper to `lib/api.ts`**

In `apps/web/src/lib/api.ts`, add after the existing `patch` export:

```ts
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });
```

- [ ] **Step 4: Create the data hooks**

Create `apps/web/src/features/app/members/useMembers.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HouseholdDTO, InviteDTO, InviteMemberInput, MemberDTO, UpdateMemberInput } from "@household/shared";
import { del, get, patch, post } from "../../../lib/api";

export function useHousehold(householdId: string | undefined) {
  return useQuery({
    queryKey: ["household", householdId],
    queryFn: ({ signal }) => get<HouseholdDTO>(`/households/${householdId}`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useMembers(householdId: string | undefined) {
  return useQuery({
    queryKey: ["members", householdId],
    queryFn: ({ signal }) => get<MemberDTO[]>(`/households/${householdId}/members`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useInvites(householdId: string | undefined) {
  return useQuery({
    queryKey: ["invites", householdId],
    queryFn: ({ signal }) => get<InviteDTO[]>(`/households/${householdId}/invites`, signal).then((r) => r.data),
    enabled: !!householdId,
  });
}

export function useInviteMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InviteMemberInput) => post<InviteDTO>(`/households/${householdId}/invites`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", householdId] }),
  });
}

export function useRevokeInvite(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => del<null>(`/households/${householdId}/invites/${inviteId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", householdId] }),
  });
}

export function useResendInvite(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => post<InviteDTO>(`/households/${householdId}/invites/${inviteId}/resend`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites", householdId] }),
  });
}

export function useUpdateMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UpdateMemberInput }) => patch<MemberDTO>(`/households/${householdId}/members/${userId}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", householdId] }),
  });
}

export function useRemoveMember(householdId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => del<null>(`/households/${householdId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", householdId] }),
  });
}

export function useLeaveHousehold(householdId: string) {
  return useMutation({ mutationFn: () => del<null>(`/households/${householdId}/members/me`) });
}
```

- [ ] **Step 5: Create `MembersPage.tsx`**

Create `apps/web/src/features/app/members/MembersPage.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Mail, Trash2, UserMinus } from "lucide-react";
import type { HouseholdRole } from "@household/shared";
import { inviteMemberSchema } from "@household/shared";
import { ApiError } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { Button } from "../../../components/Button";
import { TextField } from "../../../components/TextField";
import { useFormErrors } from "../../auth/useFormErrors";
import { zodFieldErrors } from "../../auth/zod-errors";
import { useActiveHousehold } from "../useActiveHousehold";
import {
  useHousehold, useInviteMember, useInvites, useMembers, useRemoveMember, useResendInvite, useRevokeInvite, useUpdateMember,
} from "./useMembers";

const ROLE_LABEL: Record<HouseholdRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Member", VIEWER: "View only" };
const ALL_ROLES: HouseholdRole[] = ["OWNER", "ADMIN", "MEMBER", "VIEWER"];
const INVITABLE_ROLES: HouseholdRole[] = ["ADMIN", "MEMBER", "VIEWER"];

function messageFrom(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}

export function MembersPage() {
  const { household: active } = useActiveHousehold();
  const householdId = active?.id;
  const householdQuery = useHousehold(householdId);
  const membersQuery = useMembers(householdId);
  const invitesQuery = useInvites(householdId);
  const canManage = householdQuery.data?.permissions.includes("members.manage") ?? false;

  const inviteMember = useInviteMember(householdId ?? "");
  const revokeInvite = useRevokeInvite(householdId ?? "");
  const resendInvite = useResendInvite(householdId ?? "");
  const updateMember = useUpdateMember(householdId ?? "");
  const removeMember = useRemoveMember(householdId ?? "");

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<HouseholdRole>("MEMBER");
  const [pageError, setPageError] = useState<string | null>(null);
  const errors = useFormErrors();

  function onInvite(e: FormEvent) {
    e.preventDefault();
    errors.clear();
    const parsed = inviteMemberSchema.safeParse({ email, role });
    if (!parsed.success) return errors.setFields(zodFieldErrors(parsed.error));
    inviteMember.mutate(parsed.data, { onSuccess: () => { setEmail(""); setRole("MEMBER"); }, onError: errors.fromError });
  }

  if (!householdId) return null;

  return (
    <>
      <header className="page-head"><h1 className="page-title">Members</h1></header>
      {pageError && <Alert tone="error" title={pageError} />}

      <h2 className="section-title">Active members</h2>
      <div className="list">
        {membersQuery.data?.map((m) => (
          <div key={m.userId} className="list__item">
            <span className="list__text">
              <span className="list__label" style={{ display: "block" }}>{m.displayName || m.name}</span>
              <span className="list__meta">{m.email}</span>
            </span>
            {canManage ? (
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <select
                  className="input" aria-label={`Role for ${m.name}`} value={m.role}
                  onChange={(e) => updateMember.mutate(
                    { userId: m.userId, body: { role: e.target.value as HouseholdRole } },
                    { onError: (err) => setPageError(messageFrom(err)) },
                  )}
                >
                  {ALL_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <Button
                  variant="ghost" icon={<UserMinus size={20} aria-hidden />} aria-label={`Remove ${m.name}`}
                  onClick={() => removeMember.mutate(m.userId, { onError: (err) => setPageError(messageFrom(err)) })}
                />
              </span>
            ) : (
              <span className="badge badge--neutral">{ROLE_LABEL[m.role]}</span>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <>
          <h2 className="section-title">Pending invites</h2>
          <div className="list">
            {invitesQuery.data?.length === 0 && <p className="list__meta" style={{ padding: "var(--space-3) 0" }}>No pending invites.</p>}
            {invitesQuery.data?.map((inv) => (
              <div key={inv.id} className="list__item">
                <span className="list__text">
                  <span className="list__label" style={{ display: "block" }}>{inv.email}</span>
                  <span className="list__meta">Invited as {ROLE_LABEL[inv.role]}</span>
                </span>
                <span style={{ display: "flex", gap: "var(--space-2)" }}>
                  <Button variant="ghost" icon={<Mail size={20} aria-hidden />} loading={resendInvite.isPending} onClick={() => resendInvite.mutate(inv.id)}>Resend</Button>
                  <Button variant="ghost" icon={<Trash2 size={20} aria-hidden />} aria-label={`Revoke invite for ${inv.email}`} onClick={() => revokeInvite.mutate(inv.id)} />
                </span>
              </div>
            ))}
          </div>

          <h2 className="section-title">Invite someone</h2>
          <form className="auth__form" onSubmit={onInvite} noValidate>
            {errors.formError && <Alert tone="error" title={errors.formError} />}
            <TextField label="Email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.fieldErrors.email} />
            <div className="field">
              <label className="field__label" htmlFor="invite-role">Role</label>
              <select id="invite-role" className="input" value={role} onChange={(e) => setRole(e.target.value as HouseholdRole)}>
                {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </div>
            <Button type="submit" block loading={inviteMember.isPending}>Send invite</Button>
          </form>
        </>
      )}
    </>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- MembersPage.test.tsx`
Expected: PASS.

- [ ] **Step 7: Wire the route and navigation**

In `apps/web/src/App.tsx`, add the import next to the other `app` feature imports:

```ts
import { MembersPage } from "./features/app/members/MembersPage";
```

Add the route inside the `<Route element={<RequireAuth><AppShell /></RequireAuth>}>` block, next to `<Route path="more" element={<MorePage />} />`:

```tsx
        <Route path="members" element={<MembersPage />} />
```

In `apps/web/src/features/app/MorePage.tsx`, add a `Link` import and a new "Household" section. Change the top import line:

```tsx
import { Link, useNavigate } from "react-router-dom";
```

Add this block right after the "Your homes" `<div style={{ marginTop: "var(--space-3)" }}>...Add another home` block and before `<h2 className="section-title">Account</h2>`:

```tsx
      <h2 className="section-title">Household</h2>
      <div className="list">
        <Link to="/members" className="list__item">
          <span className="list__label">Members</span>
        </Link>
      </div>
```

- [ ] **Step 8: Add "Leave household" to the Account section**

In `apps/web/src/features/app/MorePage.tsx`, add these imports:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../lib/api";
import { Alert } from "../../components/Alert";
import { meKey } from "../auth/session";
import { useLeaveHousehold } from "./members/useMembers";
```

Inside the `MorePage` component, add after the existing hook calls:

```tsx
  const qc = useQueryClient();
  const leaveHousehold = useLeaveHousehold(household?.id ?? "");
  const [leaveError, setLeaveError] = useState<string | null>(null);

  function onLeave() {
    if (!household) return;
    if (!window.confirm(`Leave ${household.name}? You'll need a new invite to rejoin.`)) return;
    leaveHousehold.mutate(undefined, {
      onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
      onError: (err) => setLeaveError(err instanceof ApiError ? err.message : "Something went wrong."),
    });
  }
```

Add this inside the "Account" `<div className="list">` block, right after the existing member `<div className="list__item">`:

```tsx
        {leaveError && <Alert tone="error" title={leaveError} />}
```

And after the whole Account `<div className="list">` block, before the sign-out `<div>`:

```tsx
      {household && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <Button variant="danger" block loading={leaveHousehold.isPending} onClick={onLeave}>Leave {household.name}</Button>
        </div>
      )}
```

- [ ] **Step 9: Run the full web test suite and typecheck**

Run: `npm run test --workspace @household/web && npm run typecheck --workspace @household/web`
Expected: PASS (no regressions in `SignInPage.test.tsx` or `guards.test.ts`).

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/features/app/members apps/web/src/App.tsx apps/web/src/features/app/MorePage.tsx
git commit -m "feat(web): members list, invite form, and leave-household"
```

---

### Task 5: Web — accept-invite flow

**Files:**
- Create: `apps/web/src/features/app/members/AcceptInvitePage.tsx`
- Test: `apps/web/src/features/app/members/AcceptInvitePage.test.tsx`
- Modify: `apps/web/src/App.tsx` (add the `/invites/accept` route)
- Modify: `apps/web/src/features/auth/SignInPage.tsx` (carry `from` state into the sign-up link)
- Modify: `apps/web/src/features/auth/SignUpPage.tsx` (honour `from` state after signup)

**Interfaces:**
- Consumes: `post` (`lib/api.ts`), `HouseholdDTO` (`@household/shared`), `Alert` (`components/Alert.tsx`), `AuthLayout` (`features/auth/AuthLayout.tsx`), `meKey` (`features/auth/session.ts`), `setActiveHouseholdId` (`lib/active-household.ts`), `RequireAuth` (`features/app/guards.tsx`).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/features/app/members/AcceptInvitePage.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AcceptInvitePage } from "./AcceptInvitePage";

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><AcceptInvitePage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AcceptInvitePage", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("shows an error when the link has no token", async () => {
    renderAt("/invites/accept");
    expect(await screen.findByText("This invite link is incomplete.")).toBeInTheDocument();
  });

  it("posts the token from the URL and shows the server's error on mismatch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ success: false, error: { code: "FORBIDDEN", message: "This invite is for other@example.com. Sign out and sign in as that address to accept it." } }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));
    renderAt("/invites/accept?token=abc123&email=other@example.com");
    expect(await screen.findByRole("alert")).toHaveTextContent("This invite is for other@example.com");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("/invites/accept");
    expect((init as RequestInit).method).toBe("POST");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace @household/web -- AcceptInvitePage.test.tsx`
Expected: FAIL — `./AcceptInvitePage` doesn't exist yet.

- [ ] **Step 3: Create `AcceptInvitePage.tsx`**

Create `apps/web/src/features/app/members/AcceptInvitePage.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HouseholdDTO } from "@household/shared";
import { post } from "../../../lib/api";
import { Alert } from "../../../components/Alert";
import { AuthLayout } from "../../auth/AuthLayout";
import { meKey } from "../../auth/session";
import { setActiveHouseholdId } from "../../../lib/active-household";

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const qc = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: () => post<HouseholdDTO>("/invites/accept", { token }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: meKey });
      setActiveHouseholdId(data.id);
      navigate("/", { replace: true });
    },
  });
  const fired = useRef(false); // StrictMode double-effect guard: the token is single-use
  useEffect(() => {
    if (token && !fired.current) { fired.current = true; mutation.mutate(); }
  }, [token, mutation]);

  return (
    <AuthLayout title="Joining household" footer={<p><Link to="/">Continue to the app</Link></p>}>
      {!token && <Alert tone="error" title="This invite link is incomplete.">Open the link from your email again.</Alert>}
      {mutation.isPending && <Alert tone="info" title="Joining…" />}
      {mutation.isError && <Alert tone="error" title={mutation.error.message} />}
    </AuthLayout>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace @household/web -- AcceptInvitePage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the route**

In `apps/web/src/App.tsx`, add the import:

```ts
import { AcceptInvitePage } from "./features/app/members/AcceptInvitePage";
```

Add the route next to the other top-level (non-`AppShell`) routes, e.g. after `/onboarding/new`:

```tsx
      <Route path="/invites/accept" element={<RequireAuth needsHousehold={false}><AcceptInvitePage /></RequireAuth>} />
```

`RequireAuth` (already in `apps/web/src/features/app/guards.tsx`) redirects an unauthenticated visitor to `/signin` with `state={{ from: location.pathname + location.search }}` — since `location.search` includes `?token=...&email=...`, the token survives the sign-in/sign-up round trip automatically.

- [ ] **Step 6: Carry the return path from sign-in into sign-up**

In `apps/web/src/features/auth/SignInPage.tsx`, change the `footer` prop of `AuthLayout`:

```tsx
      footer={<p>New here? <Link to="/signup" state={location.state}>Create an account</Link></p>}
```

(`location` is already destructured via `useLocation()` earlier in the component — no new import needed.)

- [ ] **Step 7: Make sign-up honour the return path**

In `apps/web/src/features/auth/SignUpPage.tsx`, add `useLocation` to the import:

```tsx
import { Link, useLocation, useNavigate } from "react-router-dom";
```

Add the hook call alongside the existing ones:

```tsx
  const location = useLocation();
```

Replace the mutation's `onSuccess`:

```tsx
    onSuccess: ({ data }) => {
      qc.setQueryData(meKey, data);
      const from = (location.state as { from?: unknown } | null)?.from;
      const safe = typeof from === "string" && from.startsWith("/") && !from.startsWith("//");
      navigate(safe ? (from as string) : "/onboarding", { replace: true });
    },
```

This preserves the existing default (`/onboarding`) for a normal signup, and only redirects elsewhere when arriving via a same-app return path (e.g. from an invite link) — matching the open-redirect guard already used in `guards.tsx`'s `safeReturnPath`.

- [ ] **Step 8: Manually verify the three redirect branches**

This step isn't automatable without a running API + email, so verify by reading, not running:
- Not logged in, no account: `/invites/accept?token=X&email=Y` → `RequireAuth` redirects to `/signin` with `state.from` set → user clicks "Create an account" → `SignUpPage` gets the same `state.from` → after signup, navigates to `state.from` (back to `/invites/accept?token=X&email=Y`) → the page's `useEffect` fires the accept mutation.
- Not logged in, has account: same redirect to `/signin`, user logs in → `RedirectIfSignedIn` (already existing, unchanged) sends them to `safeReturnPath(location.state.from)`, which is the same accept URL.
- Logged in as a different user: `RequireAuth` passes through (session exists) → `AcceptInvitePage` calls accept directly → server returns 403 with the "This invite is for ___" message → shown via the existing `mutation.isError` `Alert`.

- [ ] **Step 9: Run the full web test suite, typecheck, lint, and build**

Run: `npm run test --workspace @household/web && npm run typecheck && npm run lint && npm run build`
Expected: PASS / no errors across the whole repo (shared, api, web).

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/features/app/members/AcceptInvitePage.tsx apps/web/src/features/app/members/AcceptInvitePage.test.tsx apps/web/src/App.tsx apps/web/src/features/auth/SignInPage.tsx apps/web/src/features/auth/SignUpPage.tsx
git commit -m "feat(web): accept-invite page and signup/signin return-path handling"
```

---

## After this plan

Update `README.md`'s roadmap table: mark Phase 2's members/invites slice done, or leave as-is if you're tracking Phase 2 as one row until Spec 2 (househelps, categories, schedules) also lands — your call at execution time, not part of this plan.
