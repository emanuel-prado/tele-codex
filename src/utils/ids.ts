import { randomBytes, randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function createNonce(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function nowMs(): number {
  return Date.now();
}
