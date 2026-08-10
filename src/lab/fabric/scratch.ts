import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { ensureLabDirs, ensureRestrictedDir, labScratchDir } from "../paths";
import { FABRIC_LIMITS, SYNTHETIC_BEFORE_UTF8, SYNTHETIC_VALUE_PATH } from "./constants";
import { FabricTaskError } from "./types";

const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
const O_DIRECTORY = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY;
const FILE_MODE = 0o600;

type OpenSyncWithDir = (
  path: string,
  flags: number,
  mode: number,
  options: { dir: number },
) => number;

type ScratchIoMode = "dirfd" | "win32_pinned";

interface TrustedScratchDir {
  path: string;
  fd: number;
  identity: string;
}

let scratchIoMode: ScratchIoMode | null = null;
const trustedScratchRoots = new Map<string, TrustedScratchDir>();

function assertRegularFile(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.isDirectory() || stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) {
    throw new FabricTaskError(`${label} must be a regular file`, "sandbox_violation", "harness");
  }
}

function assertRealDirectory(stats: Stats, label: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new FabricTaskError(`${label} must be a real directory`, "sandbox_violation", "harness");
  }
}

function identityOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function platformSupportsNoFollow(): boolean {
  return typeof O_NOFOLLOW === "number" && O_NOFOLLOW !== 0;
}

function openFlags(base: number, noFollow = true): number {
  if (noFollow && platformSupportsNoFollow()) return base | O_NOFOLLOW!;
  return base;
}

function assertScratchName(name: string): void {
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name.includes("\0")) {
    throw new FabricTaskError("invalid scratch relative name", "sandbox_violation", "harness");
  }
}

function revalidateScratchDir(dir: TrustedScratchDir): void {
  const stats = fstatSync(dir.fd);
  assertRealDirectory(stats, "scratch dir");
  if (identityOf(stats) !== dir.identity) {
    throw new FabricTaskError("scratch directory identity changed", "sandbox_violation", "harness");
  }
}

function childScratchPath(dir: TrustedScratchDir, name: string): string {
  revalidateScratchDir(dir);
  assertScratchName(name);
  return join(dir.path, name);
}

function detectScratchIoMode(dir: TrustedScratchDir): ScratchIoMode {
  if (scratchIoMode !== null) return scratchIoMode;
  if (process.platform === "win32") {
    scratchIoMode = "win32_pinned";
    return scratchIoMode;
  }
  const probe = `.dirfd-probe-${process.pid}`;
  const finalName = `${probe}.ok`;
  try {
    const openWithDir = openSync as unknown as OpenSyncWithDir;
    const fd = openWithDir(probe, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR, FILE_MODE, { dir: dir.fd });
    closeSync(fd);
    renameSync(join(dir.path, probe), join(dir.path, finalName));
    if (!existsSync(join(dir.path, finalName))) {
      scratchIoMode = "win32_pinned";
      return scratchIoMode;
    }
    unlinkSync(join(dir.path, finalName));
    scratchIoMode = "dirfd";
  } catch {
    scratchIoMode = "win32_pinned";
  }
  return scratchIoMode;
}

function openAtScratch(dir: TrustedScratchDir, name: string, flags: number, mode = 0, expectDirectory = false): number {
  revalidateScratchDir(dir);
  assertScratchName(name);
  const mode_ = detectScratchIoMode(dir);
  if (mode_ === "dirfd") {
    return (openSync as unknown as OpenSyncWithDir)(name, flags, mode, { dir: dir.fd });
  }
  const fd = openSync(childScratchPath(dir, name), flags, mode);
  const opened = fstatSync(fd);
  if (expectDirectory) {
    assertRealDirectory(opened, name);
  } else {
    assertRegularFile(opened, name);
    const pathEntry = lstatSync(childScratchPath(dir, name));
    if (identityOf(opened) !== identityOf(pathEntry)) {
      throw new FabricTaskError("scratch path redirection detected", "sandbox_violation", "harness");
    }
  }
  return fd;
}

function openTrustedScratchRoot(scratchRoot: string): TrustedScratchDir {
  const abs = resolve(scratchRoot);
  let fd: number;
  if (typeof O_DIRECTORY === "number") {
    fd = openSync(abs, openFlags(fsConstants.O_RDONLY | O_DIRECTORY, true));
  } else {
    fd = openSync(abs, fsConstants.O_RDONLY);
  }
  const stats = fstatSync(fd);
  assertRealDirectory(stats, "scratch root");
  return { path: abs, fd, identity: identityOf(stats) };
}

function getTrustedScratch(scratchRoot: string): TrustedScratchDir {
  const abs = resolve(scratchRoot);
  let trusted = trustedScratchRoots.get(abs);
  if (!trusted) {
    trusted = openTrustedScratchRoot(abs);
    trustedScratchRoots.set(abs, trusted);
  }
  revalidateScratchDir(trusted);
  return trusted;
}

function releaseTrustedScratch(scratchRoot: string): void {
  const abs = resolve(scratchRoot);
  const trusted = trustedScratchRoots.get(abs);
  if (!trusted) return;
  trustedScratchRoots.delete(abs);
  try {
    closeSync(trusted.fd);
  } catch {
    /* ignore */
  }
}

function openScratchRelativePath(
  root: TrustedScratchDir,
  relativePath: string,
  flags: number,
  mode: number,
): number {
  const parts = assertSafeRelativePosixPath(relativePath).split("/");
  let current = root;
  const intermediateFds: number[] = [];
  try {
    for (let i = 0; i < parts.length; i++) {
      const isFinal = i === parts.length - 1;
      const part = parts[i]!;
      if (!isFinal) {
        const dirFlags = typeof O_DIRECTORY === "number"
          ? openFlags(fsConstants.O_RDONLY | O_DIRECTORY, true)
          : openFlags(fsConstants.O_RDONLY, true);
        const subFd = openAtScratch(current, part, dirFlags, 0, true);
        intermediateFds.push(subFd);
        const subStats = fstatSync(subFd);
        assertRealDirectory(subStats, part);
        current = { path: join(current.path, part), fd: subFd, identity: identityOf(subStats) };
        continue;
      }
      return openAtScratch(current, part, flags, mode);
    }
    throw new FabricTaskError("empty scratch path", "sandbox_violation", "harness");
  } catch (error) {
    for (const fd of intermediateFds) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    throw error;
  }
}

function readAllFromFd(fd: number, size: number): string {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < buf.length) {
    const n = readSync(fd, buf, offset, buf.length - offset, offset);
    if (n <= 0) break;
    offset += n;
  }
  if (offset !== size) {
    throw new FabricTaskError("short read from scratch file", "sandbox_violation", "harness");
  }
  return buf.toString("utf8");
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

function assertUnderScratchRoot(root: string, target: string): void {
  if (target !== root && !target.startsWith(root + sep)) {
    throw new FabricTaskError("path escapes scratch root", "sandbox_violation", "harness");
  }
}

/**
 * Resolve a relative path under scratch without following intermediate symlinks.
 * Missing final component is allowed (for create); intermediate components must exist.
 */
export function resolveInsideScratch(scratchRoot: string, relativePath: string, opts: { allowMissingFinal?: boolean } = {}): string {
  const safe = assertSafeRelativePosixPath(relativePath);
  const root = resolve(scratchRoot);
  const rootStats = lstatSync(root);
  assertRealDirectory(rootStats, "scratch root");

  let current = root;
  const parts = safe.split("/");
  for (let i = 0; i < parts.length; i++) {
    const next = join(current, parts[i]!);
    assertUnderScratchRoot(root, next);
    const isFinal = i === parts.length - 1;
    if (!existsSync(next)) {
      if (isFinal && opts.allowMissingFinal) return next;
      throw new FabricTaskError(isFinal ? `missing file ${relativePath}` : "missing intermediate directory", "sandbox_violation", "harness");
    }
    const stats = lstatSync(next);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    if (!isFinal) {
      assertRealDirectory(stats, next);
    }
    current = next;
  }
  return current;
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
  ensureRestrictedDir(join(root, dirname(SYNTHETIC_VALUE_PATH)));
  const trusted = openTrustedScratchRoot(root);
  trustedScratchRoots.set(trusted.path, trusted);
  const bytes = Buffer.from(SYNTHETIC_BEFORE_UTF8, "utf8");
  if (bytes.byteLength > FABRIC_LIMITS.maxAggregateIoBytes) {
    throw new FabricTaskError("fixture exceeds io budget", "budget_exhausted", "harness");
  }
  const fd = openScratchRelativePath(
    trusted,
    SYNTHETIC_VALUE_PATH,
    openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, true),
    FILE_MODE,
  );
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  return {
    root,
    cleanup: () => {
      releaseTrustedScratch(root);
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

export interface WalkedFile {
  relativePosix: string;
  absolute: string;
  byteLength: number;
}

/** No-follow walk; rejects symlinks and special files; enforces file/byte budgets. */
export function walkScratchFiles(scratchRoot: string): WalkedFile[] {
  const root = resolve(scratchRoot);
  const rootStats = lstatSync(root);
  assertRealDirectory(rootStats, "scratch root");
  const out: WalkedFile[] = [];
  const stack: string[] = [root];
  let aggregateBytes = 0;
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
    if (out.length >= FABRIC_LIMITS.maxScratchFiles) {
      throw new FabricTaskError("scratch file count exceeds budget", "budget_exhausted", "harness");
    }
    aggregateBytes += stats.size;
    if (aggregateBytes > FABRIC_LIMITS.maxAggregateIoBytes) {
      throw new FabricTaskError("scratch aggregate bytes exceed budget", "budget_exhausted", "harness");
    }
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
  resolveInsideScratch(scratchRoot, relativePath);
  const trusted = getTrustedScratch(scratchRoot);
  const fd = openScratchRelativePath(trusted, relativePath, openFlags(fsConstants.O_RDONLY, true), 0);
  try {
    const stats = fstatSync(fd);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    assertRegularFile(stats, relativePath);
    if (stats.size > maxBytes) {
      throw new FabricTaskError("file exceeds io budget", "budget_exhausted", "environment");
    }
    return readAllFromFd(fd, stats.size);
  } finally {
    closeSync(fd);
  }
}

export function writeScratchFileUtf8(scratchRoot: string, relativePath: string, contentUtf8: string, maxBytes: number): number {
  const bytes = Buffer.from(contentUtf8, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new FabricTaskError("write exceeds io budget", "budget_exhausted", "environment");
  }
  const safe = assertSafeRelativePosixPath(relativePath);
  const parentPath = safe.includes("/") ? safe.slice(0, safe.lastIndexOf("/")) : "";
  if (parentPath) {
    ensureRestrictedDir(join(scratchRoot, parentPath.split("/").join(sep)));
  }
  resolveInsideScratch(scratchRoot, relativePath, { allowMissingFinal: true });
  const trusted = getTrustedScratch(scratchRoot);
  const fd = openScratchRelativePath(
    trusted,
    relativePath,
    openFlags(fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, true),
    FILE_MODE,
  );
  try {
    const stats = fstatSync(fd);
    if (stats.isSymbolicLink()) {
      throw new FabricTaskError("symlink rejected", "sandbox_violation", "harness");
    }
    assertRegularFile(stats, relativePath);
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
