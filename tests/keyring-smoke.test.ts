import { describe, expect, test } from "bun:test";
import { runKeyringSmoke, type KeyringSmokeEntry } from "../scripts/keyring-smoke";

class MemoryKeyringEntry implements KeyringSmokeEntry {
  secret: Buffer | null = null;
  deletes = 0;

  async setSecret(secret: Uint8Array): Promise<void> {
    this.secret = Buffer.from(secret);
  }

  async getSecret(): Promise<Uint8Array | null> {
    return this.secret ? Buffer.from(this.secret) : null;
  }

  async deleteCredential(): Promise<boolean> {
    this.deletes += 1;
    this.secret?.fill(0);
    this.secret = null;
    return true;
  }
}

describe("runKeyringSmoke", () => {
  test("creates, exactly reads, and deletes a unique entry", async () => {
    const entry = new MemoryKeyringEntry();
    const created: Array<[string, string]> = [];
    const ids = ["service-id", "account-id"];

    await runKeyringSmoke({
      createEntry: async (service, account) => {
        created.push([service, account]);
        return entry;
      },
      createRandomBytes: (size) => Buffer.alloc(size, 0x5a),
      createId: () => ids.shift()!,
    });

    expect(created).toEqual([["opencodex.keyring-smoke.service-id", "ci-account-id"]]);
    expect(entry.deletes).toBe(1);
    expect(entry.secret).toBeNull();
  });

  test("deletes the entry when readback verification fails", async () => {
    const entry = new MemoryKeyringEntry();
    entry.getSecret = async () => Buffer.alloc(32, 0x00);

    await expect(runKeyringSmoke({
      createEntry: async () => entry,
      createRandomBytes: (size) => Buffer.alloc(size, 0x5a),
      createId: () => "test-id",
    })).rejects.toThrow("readback did not match");

    expect(entry.deletes).toBe(1);
    expect(entry.secret).toBeNull();
  });
});
