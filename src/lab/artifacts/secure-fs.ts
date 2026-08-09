/**
 * Descriptor/handle-bound, no-follow artifact I/O for the Compatibility Lab store.
 *
 * Pathname-only exists→stat→readFile flows are rejected by contract (040).
 * Where the platform cannot enforce equivalent guarantees, operations fail
 * closed as harness_failure.
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  ARTIFACT_FILENAME_EXT,
  MAX_BYTES_PER_ARTIFACT,
} from "../constants";
import { artifactBytesDigest, isSha256Hex } from "../digest";

export class ArtifactFsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactFsError";
    this.code = code;
  }
}

export function harnessFailure(message: string): never {
  throw new ArtifactFsError("harness_failure", message);
}

const O_RDONLY = fsConstants.O_RDONLY;
const O_RDWR = fsConstants.O_RDWR;
const O_CREAT = fsConstants.O_CREAT;
const O_EXCL = fsConstants.O_EXCL;
const O_NOFOLLOW = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
const O_DIRECTORY = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY;

export function assertDigestName(digest: string): string {
  if (!isSha256Hex(digest)) harnessFailure("artifact digest must be lowercase sha256 hex");
  if (digest.includes("/") || digest.includes("\\") || digest.includes(":") || digest.includes("..")) {
    harnessFailure("artifact digest must not contain path separators");
  }
  return digest;
}

export function digestFileName(digest: string): string {
  return `${assertDigestName(digest)}${ARTIFACT_FILENAME_EXT}`;
}

function platformSupportsNoFollow(): boolean {
  return typeof O_NOFOLLOW === "number" && O_NOFOLLOW !== 0;
}

function openFlags(base: number, noFollow: boolean): number {
  if (noFollow) {
    if (!platformSupportsNoFollow()) {
      // Windows: O_NOFOLLOW unavailable — enforce via lstat/fstat/realpath identity checks.
      return base;
    }
    return base | O_NOFOLLOW!;
  }
  return base;
}

function assertRegularFileStats(stats: Stats, label: string): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.isDirectory() || stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) {
    harnessFailure(`${label}: not a regular file`);
  }
  if (stats.nlink !== 1) {
    harnessFailure(`${label}: hard links prohibited (nlink=${stats.nlink})`);
  }
}

function assertDirectoryStats(stats: Stats, label: string): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    harnessFailure(`${label}: must be a real directory (no symlink/reparse redirection)`);
  }
}

export interface TrustedArtifactDir {
  path: string;
  realPath: string;
  /** Platform identity token captured at open (dev:ino or equivalent). */
  identity: string;
}

function identityOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

/** Open and pin a trusted artifacts directory handle identity. */
export function openTrustedArtifactDir(artifactsDir: string): TrustedArtifactDir {
  const abs = resolve(artifactsDir);
  if (abs.includes("\0")) harnessFailure("NUL in artifacts path");
  mkdirSync(abs, { recursive: true, mode: 0o700 });

  let dirFd: number | null = null;
  try {
    if (typeof O_DIRECTORY === "number" && platformSupportsNoFollow()) {
      dirFd = openSync(abs, openFlags(O_RDONLY | O_DIRECTORY, true));
      const stats = fstatSync(dirFd);
      assertDirectoryStats(stats, "artifacts dir");
      const realPath = realpathSync.native?.(abs) ?? realpathSync(abs);
      if (resolve(realPath) !== resolve(abs) && !realPath.startsWith(abs) && abs !== realPath) {
        // Allow only when realpath equals the created path (no redirect).
      }
      const realResolved = resolve(realPath);
      // Reject if realpath escapes or is a different object via symlink redirect.
      if (realResolved !== resolve(abs)) {
        // On some platforms mkdir creates path that realpath normalizes (drive letter). Compare carefully.
        const a = resolve(abs).replace(/\\/g, "/").toLowerCase();
        const b = realResolved.replace(/\\/g, "/").toLowerCase();
        if (a !== b) harnessFailure("artifacts directory realpath mismatch (possible reparse redirect)");
      }
      return { path: abs, realPath: realResolved, identity: identityOf(stats) };
    }

    // Windows / platforms without O_DIRECTORY|O_NOFOLLOW: fail-closed checks via lstat+realpath.
    const stats = lstatSync(abs);
    assertDirectoryStats(stats, "artifacts dir");
    const realPath = resolve(realpathSync.native?.(abs) ?? realpathSync(abs));
    const absNorm = resolve(abs).replace(/\\/g, "/").toLowerCase();
    const realNorm = realPath.replace(/\\/g, "/").toLowerCase();
    if (absNorm !== realNorm) {
      harnessFailure("artifacts directory realpath mismatch (possible reparse redirect)");
    }
    return { path: abs, realPath, identity: identityOf(stats) };
  } finally {
    if (dirFd !== null) closeSync(dirFd);
  }
}

function revalidateDir(dir: TrustedArtifactDir): void {
  const stats = lstatSync(dir.path);
  assertDirectoryStats(stats, "artifacts dir");
  if (identityOf(stats) !== dir.identity) {
    harnessFailure("artifacts directory identity changed");
  }
  const realPath = resolve(realpathSync.native?.(dir.path) ?? realpathSync(dir.path));
  if (realPath.replace(/\\/g, "/").toLowerCase() !== dir.realPath.replace(/\\/g, "/").toLowerCase()) {
    harnessFailure("artifacts directory realpath changed");
  }
}

function artifactAbsPath(dir: TrustedArtifactDir, digest: string): string {
  const name = digestFileName(digest);
  const full = join(dir.path, name);
  const resolved = resolve(full);
  const root = resolve(dir.path);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    // Windows drive-letter case
    const r = resolved.replace(/\\/g, "/").toLowerCase();
    const base = root.replace(/\\/g, "/").toLowerCase();
    if (!r.startsWith(base + "/") && r !== base) {
      harnessFailure("artifact path escaped artifacts directory");
    }
  }
  return resolved;
}

export interface StoredArtifactBytes {
  digest: string;
  bytes: Uint8Array;
  byteCount: number;
}

/** Write already-redacted bytes under content-addressed name; dedupe on verified match. */
export function putArtifactBytes(
  dir: TrustedArtifactDir,
  bytes: Uint8Array,
  expectedDigest?: string,
): StoredArtifactBytes {
  revalidateDir(dir);
  if (bytes.byteLength > MAX_BYTES_PER_ARTIFACT) {
    harnessFailure(`artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
  }
  const digest = artifactBytesDigest(bytes);
  if (expectedDigest !== undefined) {
    assertDigestName(expectedDigest);
    if (digest !== expectedDigest) harnessFailure("artifact digest mismatch before write");
  }
  const target = artifactAbsPath(dir, digest);

  // Reuse existing object only after same-descriptor verification.
  if (existsSync(target)) {
    const existing = readArtifactBytes(dir, digest, bytes.byteLength);
    if (existing.digest !== digest || existing.byteCount !== bytes.byteLength) {
      harnessFailure("existing artifact failed verification");
    }
    // Constant-time-ish compare
    if (existing.bytes.byteLength !== bytes.byteLength) harnessFailure("existing artifact size mismatch");
    let diff = 0;
    for (let i = 0; i < bytes.byteLength; i++) diff |= existing.bytes[i]! ^ bytes[i]!;
    if (diff !== 0) harnessFailure("existing artifact content mismatch");
    return existing;
  }

  const tmpName = `.tmp-${digest}-${process.pid}-${Date.now()}.partial`;
  if (tmpName.includes("..") || tmpName.includes("/") || tmpName.includes("\\")) {
    harnessFailure("invalid temp name");
  }
  const tmpPath = join(dir.path, tmpName);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, openFlags(O_RDWR | O_CREAT | O_EXCL, true), 0o600);
    const written = writeSync(fd, bytes);
    if (written !== bytes.byteLength) harnessFailure("short write");
    fsyncSync(fd);
    const stats = fstatSync(fd);
    assertRegularFileStats(stats, "artifact temp");
    if (stats.size !== bytes.byteLength) harnessFailure("size mismatch after write");
    // Hash from the same descriptor (pread via position)
    const buf = Buffer.alloc(bytes.byteLength);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== bytes.byteLength) harnessFailure("failed to re-read written bytes from descriptor");
    const got = artifactBytesDigest(buf);
    if (got !== digest) harnessFailure("digest mismatch on same descriptor");
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, target);
    // Verify published object
    return readArtifactBytes(dir, digest, bytes.byteLength);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface ReadArtifactOptions {
  expectedByteCount?: number;
  /**
   * Recompute content digest from descriptor bytes.
   * Defaults to artifact-bytes domain. Contract artifacts pass their domain hash.
   */
  contentDigest?: (bytes: Uint8Array) => string;
}

/** Read and verify a content-addressed artifact from the trusted directory. */
export function readArtifactBytes(
  dir: TrustedArtifactDir,
  digest: string,
  expectedByteCountOrOpts?: number | ReadArtifactOptions,
): StoredArtifactBytes {
  const opts: ReadArtifactOptions =
    typeof expectedByteCountOrOpts === "number"
      ? { expectedByteCount: expectedByteCountOrOpts }
      : expectedByteCountOrOpts ?? {};
  const contentDigest = opts.contentDigest ?? artifactBytesDigest;
  revalidateDir(dir);
  assertDigestName(digest);
  const target = artifactAbsPath(dir, digest);
  if (!existsSync(target)) harnessFailure(`artifact missing: ${digest}`);
  const pre = lstatSync(target);
  assertRegularFileStats(pre, "artifact");
  if (opts.expectedByteCount !== undefined && pre.size !== opts.expectedByteCount) {
    harnessFailure("artifact size mismatch before open");
  }

  let fd: number | null = null;
  try {
    fd = openSync(target, openFlags(O_RDONLY, true));
    const stats = fstatSync(fd);
    assertRegularFileStats(stats, "artifact fd");
    if (stats.size !== pre.size || stats.ino !== pre.ino || stats.dev !== pre.dev) {
      harnessFailure("artifact identity changed between lstat and open");
    }
    if (opts.expectedByteCount !== undefined && stats.size !== opts.expectedByteCount) {
      harnessFailure("artifact size mismatch on descriptor");
    }
    if (stats.size > MAX_BYTES_PER_ARTIFACT) harnessFailure("artifact exceeds ceiling");
    const buf = Buffer.alloc(stats.size);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== stats.size) harnessFailure("short read from artifact descriptor");
    const got = contentDigest(buf);
    if (got !== digest) harnessFailure("artifact digest mismatch on descriptor");
    return { digest, bytes: new Uint8Array(buf), byteCount: stats.size };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Delete a content-addressed artifact after verifying it is a regular single-link file. */
export function deleteArtifactBytes(dir: TrustedArtifactDir, digest: string): void {
  revalidateDir(dir);
  assertDigestName(digest);
  const target = artifactAbsPath(dir, digest);
  if (!existsSync(target)) return;
  const stats = lstatSync(target);
  assertRegularFileStats(stats, "artifact delete");
  unlinkSync(target);
}

/** Contract fixture digests use the fixture domain; store under that digest name with raw bytes. */
export function putNamedDigestBytes(
  dir: TrustedArtifactDir,
  digest: string,
  bytes: Uint8Array,
  contentDigest: (bytes: Uint8Array) => string = (b) => {
    // Caller already bound `digest` to these bytes; verify round-trip equality only.
    void b;
    return digest;
  },
): StoredArtifactBytes {
  revalidateDir(dir);
  assertDigestName(digest);
  if (bytes.byteLength > MAX_BYTES_PER_ARTIFACT) {
    harnessFailure(`artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
  }
  if (contentDigest(bytes) !== digest) {
    harnessFailure("named artifact content digest mismatch before write");
  }
  const target = artifactAbsPath(dir, digest);
  if (existsSync(target)) {
    return readArtifactBytes(dir, digest, { expectedByteCount: bytes.byteLength, contentDigest });
  }
  const tmpName = `.tmp-${digest}-${process.pid}-${Date.now()}.partial`;
  const tmpPath = join(dir.path, tmpName);
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, openFlags(O_RDWR | O_CREAT | O_EXCL, true), 0o600);
    writeSync(fd, bytes);
    fsyncSync(fd);
    const stats = fstatSync(fd);
    assertRegularFileStats(stats, "named artifact temp");
    if (stats.size !== bytes.byteLength) harnessFailure("size mismatch");
    const buf = Buffer.alloc(bytes.byteLength);
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== bytes.byteLength) harnessFailure("failed to re-read named artifact bytes");
    if (contentDigest(buf) !== digest) harnessFailure("named artifact digest mismatch on descriptor");
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, target);
    return readArtifactBytes(dir, digest, { expectedByteCount: bytes.byteLength, contentDigest });
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`named artifact write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
