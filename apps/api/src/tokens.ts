import { createHash, randomBytes } from "node:crypto";

/** A random, URL-safe secret: 32 bytes, base64url. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores in place of a token, so a database leak can't sign anyone in. */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}
