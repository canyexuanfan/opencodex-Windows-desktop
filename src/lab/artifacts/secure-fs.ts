/**
 * Descriptor/handle-bound, no-follow artifact I/O for the Compatibility Lab store.
 *
 * The trusted artifact directory fd remains open for the store session lifetime.
 * Child opens use openat semantics when the runtime supports them; otherwise
 * operations use revalidated absolute paths under the pinned directory identity.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
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

let openAtSupported: boolean | null = null;

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
  if (noFollow && platformSupportsNoFollow()) return base | O_NOFOLLOW!;
  return base;
}

function assertRegularFileStats(stats: Stats, label: string): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.isDirectory() ||
    stats.isFIFO() ||
    stats.isSocket() ||
    stats.isCharacterDevice() ||
    stats.isBlockDevice()
  ) {
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

function identityOf(stats: Stats): string {
  return `${stats.dev}:${stats.ino}`;
}

function assertRelativeName(name: string): void {
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    harnessFailure("invalid relative artifact name");
  }
}

export interface TrustedArtifactDir {
  path: string;
  fd: number;
  identity: string;
}

function detectOpenAt(dir: TrustedArtifactDir): boolean {
  if (openAtSupported !== null) return openAtSupported;
  const probe = `.openat-probe-${process.pid}`;
  try {
    const fd = (openSync as unknown as (p: string, f: number, o: { fd: number }) => number)(
      probe,
      O_CREAT | O_EXCL | O_RDWR,
      { fd: dir.fd },
    );
    closeSync(fd);
    try {
      (unlinkSync as (p: string, o: { fd: number }) => void)(probe, { fd: dir.fd });
    } catch {
      unlinkSync(join(dir.path, probe));
    }
    openAtSupported = true;
  } catch {
    openAtSupported = false;
  }
  return openAtSupported;
}

function childPath(dir: TrustedArtifactDir, name: string): string {
  revalidateDir(dir);
  assertRelativeName(name);
  return join(dir.path, name);
}

function openAtDir(dir: TrustedArtifactDir, name: string, flags: number, mode?: number): number {
  revalidateDir(dir);
  assertRelativeName(name);
  if (detectOpenAt(dir)) {
    const openAt = openSync as unknown as (
      p: string,
      f: number,
      o: { fd: number; mode?: number },
    ) => number;
    if (mode !== undefined) return openAt(name, flags, { fd: dir.fd, mode });
    return openAt(name, flags, { fd: dir.fd });
  }
  const full = join(dir.path, name);
  return mode !== undefined ? openSync(full, flags, mode) : openSync(full, flags);
}

function renameAtDir(dir: TrustedArtifactDir, from: string, to: string): void {
  revalidateDir(dir);
  assertRelativeName(from);
  assertRelativeName(to);
  if (detectOpenAt(dir)) {
    (renameSync as (a: string, b: string, o: { fd: number }) => void)(from, to, { fd: dir.fd });
    return;
  }
  renameSync(join(dir.path, from), join(dir.path, to));
}

function unlinkAtDir(dir: TrustedArtifactDir, name: string): void {
  revalidateDir(dir);
  assertRelativeName(name);
  if (detectOpenAt(dir)) {
    (unlinkSync as (p: string, o: { fd: number }) => void)(name, { fd: dir.fd });
    return;
  }
  unlinkSync(join(dir.path, name));
}

function revalidateDir(dir: TrustedArtifactDir): void {
  const stats = fstatSync(dir.fd);
  assertDirectoryStats(stats, "artifacts dir");
  if (identityOf(stats) !== dir.identity) {
    harnessFailure("artifacts directory identity changed");
  }
}

export function openTrustedArtifactDir(artifactsDir: string): TrustedArtifactDir {
  const abs = artifactsDir.replace(/[\\/]+$/, "");
  if (abs.includes("\0")) harnessFailure("NUL in artifacts path");
  mkdirSync(abs, { recursive: true, mode: 0o700 });

  let fd: number;
  if (typeof O_DIRECTORY === "number") {
    try {
      fd = openSync(abs, openFlags(O_RDONLY | O_DIRECTORY, true));
    } catch {
      harnessFailure("failed to open artifacts directory with O_DIRECTORY");
    }
  } else {
    fd = openSync(abs, O_RDONLY);
  }

  const stats = fstatSync(fd);
  assertDirectoryStats(stats, "artifacts dir");
  return { path: abs, fd, identity: identityOf(stats) };
}

export function closeTrustedArtifactDir(dir: TrustedArtifactDir): void {
  try {
    closeSync(dir.fd);
  } catch {
    /* ignore */
  }
}

export interface StoredArtifactBytes {
  digest: string;
  bytes: Uint8Array;
  byteCount: number;
}

export interface ReadArtifactOptions {
  expectedByteCount?: number;
  contentDigest?: (bytes: Uint8Array) => string;
}

function readAllFromFd(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let offset = 0;
  while (offset < buf.length) {
    const n = readSync(fd, buf, offset, buf.length - offset, offset);
    if (n <= 0) break;
    offset += n;
  }
  if (offset !== size) harnessFailure("short read from artifact descriptor");
  return buf;
}

function writeTempArtifact(
  dir: TrustedArtifactDir,
  tmpName: string,
  bytes: Uint8Array,
  digest: string,
  contentDigest: (b: Uint8Array) => string,
): void {
  let fd: number | null = null;
  try {
    fd = openAtDir(dir, tmpName, openFlags(O_RDWR | O_CREAT | O_EXCL, true), 0o600);
    const written = writeSync(fd, bytes);
    if (written !== bytes.byteLength) harnessFailure("short write");
    fsyncSync(fd);
    const stats = fstatSync(fd);
    assertRegularFileStats(stats, "artifact temp");
    if (stats.size !== bytes.byteLength) harnessFailure("size mismatch after write");
    const buf = readAllFromFd(fd, bytes.byteLength);
    if (contentDigest(buf) !== digest) harnessFailure("digest mismatch on same descriptor");
    closeSync(fd);
    fd = null;
    renameAtDir(dir, tmpName, digestFileName(digest));
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try {
      unlinkAtDir(dir, tmpName);
    } catch {
      /* ignore cleanup */
    }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
  const name = digestFileName(digest);

  let fd: number | null = null;
  try {
    fd = openAtDir(dir, name, openFlags(O_RDONLY, true));
    const stats = fstatSync(fd);
    assertRegularFileStats(stats, "artifact fd");
    if (opts.expectedByteCount !== undefined && stats.size !== opts.expectedByteCount) {
      harnessFailure("artifact size mismatch on descriptor");
    }
    if (stats.size > MAX_BYTES_PER_ARTIFACT) harnessFailure("artifact exceeds ceiling");
    const buf = readAllFromFd(fd, stats.size);
    const got = contentDigest(buf);
    if (got !== digest) harnessFailure("artifact digest mismatch on descriptor");
    return { digest, bytes: new Uint8Array(buf), byteCount: stats.size };
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      harnessFailure(`artifact missing: ${digest}`);
    }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact read failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  harnessFailure("artifact read failed");
}

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

  try {
    return readArtifactBytes(dir, digest, bytes.byteLength);
  } catch (err) {
    if (!(err instanceof ArtifactFsError) || !err.message.includes("missing")) {
      if (err instanceof ArtifactFsError && err.message.includes("mismatch")) throw err;
    }
  }

  const tmpName = `.tmp-${digest}-${process.pid}-${Date.now()}.partial`;
  writeTempArtifact(dir, tmpName, bytes, digest, artifactBytesDigest);
  return readArtifactBytes(dir, digest, bytes.byteLength);
}

export function putNamedDigestBytes(
  dir: TrustedArtifactDir,
  digest: string,
  bytes: Uint8Array,
  contentDigest: (bytes: Uint8Array) => string,
): StoredArtifactBytes {
  revalidateDir(dir);
  assertDigestName(digest);
  if (bytes.byteLength > MAX_BYTES_PER_ARTIFACT) {
    harnessFailure(`artifact exceeds ${MAX_BYTES_PER_ARTIFACT} bytes`);
  }
  if (contentDigest(bytes) !== digest) {
    harnessFailure("named artifact content digest mismatch before write");
  }

  try {
    return readArtifactBytes(dir, digest, { expectedByteCount: bytes.byteLength, contentDigest });
  } catch (err) {
    if (!(err instanceof ArtifactFsError) || !err.message.includes("missing")) {
      throw err;
    }
  }

  const tmpName = `.tmp-${digest}-${process.pid}-${Date.now()}.partial`;
  writeTempArtifact(dir, tmpName, bytes, digest, contentDigest);
  return readArtifactBytes(dir, digest, { expectedByteCount: bytes.byteLength, contentDigest });
}

export function deleteArtifactBytes(dir: TrustedArtifactDir, digest: string): void {
  revalidateDir(dir);
  assertDigestName(digest);
  const name = digestFileName(digest);
  try {
    unlinkAtDir(dir, name);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      return;
    }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function artifactExists(dir: TrustedArtifactDir, digest: string): boolean {
  revalidateDir(dir);
  assertDigestName(digest);
  try {
    const fd = openAtDir(dir, digestFileName(digest), openFlags(O_RDONLY, true));
    try {
      const stats = fstatSync(fd);
      assertRegularFileStats(stats, "artifact exists");
      return true;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      return false;
    }
    if (err instanceof ArtifactFsError) throw err;
    harnessFailure(`artifact exists check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
