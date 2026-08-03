import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  type Stats,
} from "node:fs";

import { hardenSecretPathAsync } from "../lib/windows-secret-acl";

export interface StableLockFile {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  close(): void;
}

interface StableLockEntry {
  readonly fd: number;
  readonly dev: number;
  readonly ino: number;
  refs: number;
}

// POSIX fcntl locks are process-associated: closing any raw descriptor for an
// inode can release SQLite locks held through a different descriptor in this
// process. Keep one side descriptor per canonical lock path and close it only
// after every SQLite user has closed its connection and released its reference.
const stableLockEntries = new Map<string, StableLockEntry>();

function reference(path: string, entry: StableLockEntry): StableLockFile {
  let closed = false;
  return {
    fd: entry.fd,
    dev: entry.dev,
    ino: entry.ino,
    close() {
      if (closed) return;
      closed = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs !== 0) return;
      if (stableLockEntries.get(path) === entry) stableLockEntries.delete(path);
      closeSync(entry.fd);
    },
  };
}

function assertRegular(stats: Stats, path: string): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`unsafe SQLite lock path: ${path}`);
}

function matches(handle: StableLockFile, stats: Stats): boolean {
  return handle.dev === stats.dev && handle.ino === stats.ino;
}

export function openStableLockFile(path: string, platform: NodeJS.Platform = process.platform): StableLockFile {
  const retained = stableLockEntries.get(path);
  if (retained) {
    retained.refs += 1;
    const handle = reference(path, retained);
    try {
      assertStableLockFile(path, handle);
      return handle;
    } catch (error) {
      handle.close();
      throw error;
    }
  }
  if (existsSync(path)) assertRegular(lstatSync(path), path);
  const noFollow = platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | noFollow, 0o600);
  try {
    const descriptor = fstatSync(fd);
    assertRegular(descriptor, path);
    const entry: StableLockEntry = {
      fd,
      dev: descriptor.dev,
      ino: descriptor.ino,
      refs: 1,
    };
    stableLockEntries.set(path, entry);
    const handle = reference(path, entry);
    assertStableLockFile(path, handle);
    return handle;
  } catch (error) {
    const entry = stableLockEntries.get(path);
    if (entry?.fd === fd) stableLockEntries.delete(path);
    closeSync(fd);
    throw error;
  }
}

export function assertStableLockFile(path: string, handle: StableLockFile): void {
  const pathStats = lstatSync(path);
  assertRegular(pathStats, path);
  if (!matches(handle, pathStats)) throw new Error(`SQLite lock path identity changed: ${path}`);
}

export async function hardenStableLockFile(path: string): Promise<void> {
  try { chmodSync(path, 0o600); } catch { /* Windows ACL below is authoritative there. */ }
  if (process.platform === "win32") {
    await hardenSecretPathAsync(path, { required: true, timeoutMemoKey: path });
  }
}
