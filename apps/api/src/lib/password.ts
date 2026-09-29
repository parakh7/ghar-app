import { hash, verify } from "@node-rs/argon2";

// OWASP 2024 argon2id baseline: m=19 MiB, t=2, p=1
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain);
  } catch {
    return false;
  }
}

/** Pre-computed so logins for unknown emails take the same time as real ones (no user enumeration). */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("timing-equaliser-not-a-real-password");
  return dummyHash;
}
