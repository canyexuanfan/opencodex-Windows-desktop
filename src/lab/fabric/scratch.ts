import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureLabDirs, labScratchDir } from "../paths";
import { FABRIC_LIMITS, SYNTHETIC_BEFORE_UTF8, SYNTHETIC_VALUE_PATH } from "./constants";
import { FabricTaskError } from "./types";

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;

function ensureRestrictedDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const mode = lstatSync(dir).mode & 0o777;
  if (mode !== 0o700) chmodSync(dir, 0o700);
}

function assertRegularFile(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.isDirectory() || stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) {
    throw new FabricTaskError(`${label} must be a regular file`, "sandbox_violation", "harness");
  }
}

/** Normalize and reject traversal / absolute / Windows drive / NUL paths. */
export function assertSafeRelativePosixPath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new FabricTaskError("path required", "sandbox_violation", "harness");
  }
  if (raw.includes("\0") || raw.includes("\\")) {
    throw new FabricTaskError("path contains forbidden characters", "sandbox_violation", "harness");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new FabricTaskError("absolute paths are forbidden", "sandbox_violation", "harness");
  }
  const normalized = posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new FabricTaskError("path traversal is forbidden", "sandbox_violation", "harness");
  }
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new FabricTaskError("invalid path segments", "sandbox_violation", "harness");
  }
  return normalized;
}

export function resolveInsideScratch(scratchRoot: string, relativePath: string): string {
  const safe = assertSafeRelativePosixPath(relativePath);
  const root = resolve(scratchRoot);
  const target = resolve(root, ...safe.split("/"));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new FabricTaskError("path escapes scratch root", "sandbox_violation", "harness");
  }
  return target;
}

export interface ScratchTree {
  root: string;
  cleanup: () => void;
}

export function createSyntheticScratch(configDir?: string): ScratchTree {
  ensureLabDirs(configDir);
  const base = labScratchDir(configDir);
  ensureRestrictedDir(base);
  const root = join(base, `fabric-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`);
  ensureRestrictedDir(root);
  const valuePath = resolveInsideScratch(root, SYNTHETIC_VALUE_PATH);
  ensureRestrictedDir(dirname(valuePath));
  const bytes = Buffer.from(SYNTHETIC_BEFORE_UTF8, "utf8");
  if (bytes.byteLength > FABRIC_LIMITS.maxAggregateIoBytes) {
    throw new FabricTaskError("fixture exceeds io budget", "budget_exhausted", "harness");
  }
  const fd = openSync(valuePath, openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL));
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

function openFlags(base: number): number {
  if (typeof O_NOFOLLOW === "number" && O_NOFOLLOW !== 0) return base | O_NOFOLLOW;
  return base;
}

export interface WalkedFile {
  relativePosix: string;
  absolute: string;
  byteLength: number;
}

/** No-follow walk; rejects symlinks and special files. */
export function walkScratchFiles(scratchRoot: string): WalkedFile[] {
  const root = resolve(scratchRoot);
  const out: WalkedFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    if (stats.isDirectory()) {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        stack.push(join(current, entry.name));
      }
      continue;
    }
    assertRegularFile(stats, current);
    const rel = relative(root, current).split(sep).join("/");
    const safe = assertSafeRelativePosixPath(rel);
    out.push({ relativePosix: safe, absolute: current, byteLength: stats.size });
  }
  out.sort((a, b) => {
    const left = Buffer.from(a.relativePosix, "utf8");
    const right = Buffer.from(b.relativePosix, "utf8");
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n; i++) {
      const d = left[i]! - right[i]!;
      if (d !== 0) return d;
    }
    return left.length - right.length;
  });
  return out;
}

export function readScratchFileUtf8(scratchRoot: string, relativePath: string, maxBytes: number): string {
  const absolute = resolveInsideScratch(scratchRoot, relativePath);
  if (!existsSync(absolute)) {
    throw new FabricTaskError(`missing file ${relativePath}`, "sandbox_violation", "harness");
  }
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink()) {
    throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
  }
  assertRegularFile(stats, relativePath);
  if (stats.size > maxBytes) {
    throw new FabricTaskError("file exceeds io budget", "budget_exhausted", "environment");
  }
  return readFileSync(absolute, "utf8");
}

export function writeScratchFileUtf8(scratchRoot: string, relativePath: string, contentUtf8: string, maxBytes: number): number {
  const absolute = resolveInsideScratch(scratchRoot, relativePath);
  const bytes = Buffer.from(contentUtf8, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new FabricTaskError("write exceeds io budget", "budget_exhausted", "environment");
  }
  ensureRestrictedDir(dirname(absolute));
  if (existsSync(absolute)) {
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    assertRegularFile(stats, relativePath);
  }
  const fd = openSync(absolute, openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC));
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return bytes.byteLength;
}

/** Prove the resolved path cannot escape into a caller-provided user repository root. */
export function assertNotUnderUserRepo(scratchRoot: string, userRepoRoot: string): void {
  const scratch = resolve(scratchRoot);
  const repo = resolve(userRepoRoot);
  if (scratch === repo || scratch.startsWith(repo + sep)) {
    throw new FabricTaskError("scratch must not live inside user repository", "sandbox_violation", "harness");
  }
}
