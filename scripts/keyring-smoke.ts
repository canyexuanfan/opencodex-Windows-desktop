#!/usr/bin/env bun
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface KeyringSmokeEntry {
  setSecret(secret: Uint8Array, signal?: AbortSignal): Promise<void>;
  getSecret(signal?: AbortSignal): Promise<Uint8Array | null>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

export interface KeyringSmokeOptions {
  createEntry?: (service: string, account: string) => Promise<KeyringSmokeEntry>;
  createRandomBytes?: (size: number) => Buffer;
  createId?: () => string;
  timeoutMs?: number;
}

async function createOsEntry(service: string, account: string): Promise<KeyringSmokeEntry> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(service, account);
}

export async function runKeyringSmoke({
  createEntry = createOsEntry,
  createRandomBytes = randomBytes,
  createId = randomUUID,
  timeoutMs = 8_000,
}: KeyringSmokeOptions = {}): Promise<void> {
  const service = `opencodex.keyring-smoke.${createId()}`;
  const account = `ci-${createId()}`;
  const secret = createRandomBytes(32);
  let entry: KeyringSmokeEntry | null = null;
  let stored: Buffer | null = null;

  try {
    entry = await createEntry(service, account);
    await entry.setSecret(secret, AbortSignal.timeout(timeoutMs));
    const readback = await entry.getSecret(AbortSignal.timeout(timeoutMs));
    stored = readback ? Buffer.from(readback) : null;
    if (!stored || stored.byteLength !== secret.byteLength || !timingSafeEqual(stored, secret)) {
      throw new Error("OS keyring smoke readback did not match the stored value.");
    }
  } finally {
    try {
      if (entry && !await entry.deleteCredential(AbortSignal.timeout(timeoutMs))) {
        throw new Error("OS keyring smoke could not delete the temporary entry.");
      }
    } finally {
      stored?.fill(0);
      secret.fill(0);
    }
  }
}

if (import.meta.main) {
  await runKeyringSmoke();
  console.log("OS keyring create/read/delete smoke passed.");
}
