/**
 * Windows-tolerant atomic replace.
 *
 * POSIX `rename()` replaces the destination entry unconditionally. Windows can
 * refuse the same call with EBUSY, EPERM or EACCES while another process holds
 * the target open — a real-time scanner that just indexed the file, a sync
 * client, a backup agent. The hold is usually momentary, so a bounded retry
 * turns an operational failure back into a successful publish.
 *
 * The envelope is deliberately small: two retries, 25ms then 50ms, about 75ms
 * total. It is sized for a scanner blinking, not for a file someone actually
 * has open. Widening it without evidence would trade a rare failure for a
 * routine stall.
 *
 * This lives in its own module rather than in config.ts because
 * config-ownership.ts is one of its callers and config.ts already imports
 * config-ownership.ts — exporting it from there would close an import cycle.
 */

import { renameSync } from "node:fs";

export interface AtomicRenameIO {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => void;
  sleep: (milliseconds: number) => void;
}

const MAX_RETRIES = 2;

/** Windows sharing violations only. Any other error is the caller's to see, immediately. */
function isTransientWindowsReplaceError(platform: NodeJS.Platform, error: unknown): boolean {
  if (platform !== "win32") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

export function renameAtomicFile(
  source: string,
  destination: string,
  io: AtomicRenameIO = {
    platform: process.platform,
    rename: renameSync,
    sleep: Bun.sleepSync,
  },
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientWindowsReplaceError(io.platform, error)) throw error;
      if (attempt >= MAX_RETRIES) throw error;
      io.sleep(25 * (attempt + 1));
    }
  }
}

export async function renameAtomicFileAsync(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (!isTransientWindowsReplaceError(process.platform, error)) throw error;
      if (attempt >= MAX_RETRIES) throw error;
      await Bun.sleep(25 * (attempt + 1));
    }
  }
}
