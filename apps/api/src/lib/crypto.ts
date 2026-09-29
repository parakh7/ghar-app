import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256-bit URL-safe random token. The raw value is only ever sent to the user. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are high-entropy, so a fast hash is sufficient (no salt/KDF needed). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
