import { constants, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../config";
import { applyEol, dominantEol, isLoopbackHostname, providerBaseHost } from "../codex/inject";

export interface GrokInjectModel {
  id: string;
  name?: string;
  contextWindow?: number;
}

export interface GrokInjectResult {
  ok: boolean;
  changed: boolean;
  message: string;
  skippedReason?: "no-grok-home" | "orphaned-marker" | "non-loopback";
}

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const END_MARKER = "# <<< opencodex managed block <<<";
// grok 0.2.101 verified live (2026-07-23): [model_providers.<id>] inheritance parses but the
// inherited base_url is NOT applied to inference routing — the turn falls through to the default
// cli-chat-proxy and 401s. Per-model direct fields DO route. So every [model.*] block carries its
// own base_url/api_backend/api_key and no [model_providers] table is emitted at all.

interface ManagedRegion {
  start: number;
  end: number;
  orphaned: boolean;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function resolveGrokHome(grokHome?: string): string {
  return grokHome ?? (process.env.GROK_HOME || join(homedir(), ".grok"));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findManagedRegion(content: string): ManagedRegion | null {
  const start = content.indexOf(BEGIN_MARKER);
  if (start === -1) return null;
  const endMarkerStart = content.indexOf(END_MARKER, start + BEGIN_MARKER.length);
  if (endMarkerStart === -1) return { start, end: content.length, orphaned: true };
  return { start, end: endMarkerStart + END_MARKER.length, orphaned: false };
}

/**
 * A TOML key segment as it may be spelled in a table header: bare, basic string, or literal
 * string. All three spellings of the same key address the SAME table, so both segments of a
 * `[model.<alias>]` header must be canonicalized before comparison.
 */
const KEY_SEGMENT = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
/**
 * User-owned model table headers. Also matches array-of-table (`[[model.x]]`) and sub-table
 * (`[model.x.sub]`) spellings: both collide with a generated `[model.x]` and a single collision
 * makes grok reject the ENTIRE config layer ("duplicate key"), taking every unrelated user
 * setting with it. Reserving conservatively is always cheaper than that failure.
 */
const MODEL_TABLE_HEADER = new RegExp(
  String.raw`^\s*\[\[?\s*(${KEY_SEGMENT})\s*\.\s*(${KEY_SEGMENT})\s*(?:\.[^\]]*)?\]\]?\s*(?:#.*)?$`,
  "gm",
);

/** Resolve a header key segment (bare / basic / literal) to the key it actually addresses. */
function canonicalKeySegment(raw: string): string {
  if (raw.startsWith('"')) return decodeTomlBasicString(raw.slice(1, -1));
  if (raw.startsWith("'")) return raw.slice(1, -1); // literal strings have no escapes
  return raw;
}

/**
 * `[model.<alias>]` table headers the USER owns (outside our fence) — reserved for collisions.
 * TOML admits equivalent header spellings for BOTH segments (`["model"."ocx-mine"]`,
 * `['model'.ocx-mine]`, `[ model . ocx-mine ]`); all of them redefine the same table, so each
 * form is canonicalized before it is reserved.
 */
function userModelAliases(content: string, region: ManagedRegion | null): Set<string> {
  const outsideManagedRegion = region
    ? content.slice(0, region.start) + content.slice(region.end)
    : content;
  const aliases = new Set<string>();
  for (const match of outsideManagedRegion.matchAll(MODEL_TABLE_HEADER)) {
    if (canonicalKeySegment(match[1]!) !== "model") continue;
    aliases.add(canonicalKeySegment(match[2]!));
  }
  return aliases;
}

function orphanedMarkerResult(action: string): GrokInjectResult {
  return {
    ok: false,
    changed: false,
    message: `Grok config ${action} refused: found the opencodex begin marker without its end marker. `
      + "The managed region boundary is ambiguous, so nothing was modified. "
      + "Repair ~/.grok/config.toml manually (see config.toml.bak-opencodex) and re-run.",
    skippedReason: "orphaned-marker",
  };
}

function copyBackupOnce(configPath: string, backupPath: string): void {
  if (existsSync(backupPath)) return;
  try {
    copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

function errorResult(action: string, error: unknown): GrokInjectResult {
  const detail = error instanceof Error ? error.message : String(error);
  return { ok: false, changed: false, message: `Could not ${action} Grok config: ${detail}` };
}

export function buildGrokManagedBlock(port: number, models: GrokInjectModel[], hostname?: string, reservedAliases?: ReadonlySet<string>): string {
  const host = providerBaseHost(hostname);
  const baseUrl = `http://${host}:${port}/v1`;
  const lines = [
    BEGIN_MARKER,
  ];
  const aliasCounts = new Map<string, number>();
  const taken = new Set(reservedAliases ?? []);

  for (const model of models) {
    const baseAlias = `ocx-${model.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    let count = (aliasCounts.get(baseAlias) ?? 0) + 1;
    let alias = count === 1 ? baseAlias : `${baseAlias}-${count}`;
    // User-owned [model.<alias>] tables outside the fence are reserved: emitting a
    // duplicate table header would make the whole TOML invalid for grok.
    while (taken.has(alias)) {
      count += 1;
      alias = `${baseAlias}-${count}`;
    }
    aliasCounts.set(baseAlias, count);
    taken.add(alias);
    const isFirst = lines.length === 1;
    lines.push(
      ...(isFirst ? [] : [""]),
      `[model.${alias}]`,
      `model = ${tomlString(model.id)}`,
      `base_url = ${tomlString(baseUrl)}`,
      'api_backend = "chat_completions"',
      'api_key = "opencodex-loopback"',
      `name = ${tomlString(model.name ?? `OCX ${model.id}`)}`,
    );
    if (Number.isFinite(model.contextWindow) && (model.contextWindow ?? 0) > 0) {
      lines.push(`context_window = ${model.contextWindow}`);
    }
  }

  lines.push(END_MARKER);
  return lines.join("\n");
}

export function injectGrokConfig(
  port: number,
  models: GrokInjectModel[],
  opts: { grokHome?: string; hostname?: string } = {},
): GrokInjectResult {
  const grokHome = resolveGrokHome(opts.grokHome);
  if (!isDirectory(grokHome)) {
    return {
      ok: true,
      changed: false,
      message: `Grok home not found at ${grokHome}; config injection skipped.`,
      skippedReason: "no-grok-home",
    };
  }

  // Non-loopback binds require the real admission token (src/server/auth-cors.ts), and there is
  // no safe way for a REGENERATED block to carry it: a literal token would write the user's
  // secret into their own file and overwrite it on every start/ensure/restart, while omitting
  // api_key in favour of env_key opens grok's credential fallthrough — with no `model_provider`
  // to fail closed, an unresolved env_key makes grok send its xAI session bearer to our
  // plaintext LAN endpoint (upstream config.rs resolve_credentials). So we do not auto-register
  // at all here; the user configures models manually, outside our fence, where nothing we do
  // can clobber their credential.
  if (!isLoopbackHostname(opts.hostname)) {
    const removed = stripGrokConfig({ ...(opts.grokHome !== undefined ? { grokHome: opts.grokHome } : {}) });
    const cleanup = removed.changed
      ? " Removed the previously generated block, which pointed at a loopback address."
      : "";
    return {
      ok: true, // a deliberate policy skip, not a failure — it must never block startup
      changed: removed.changed,
      skippedReason: "non-loopback",
      message: `Grok auto-registration skipped: opencodex is bound to the non-loopback host `
        + `"${opts.hostname}", where requests need your admission token. A managed block would `
        + `either store that secret in ~/.grok/config.toml or overwrite it on the next start, so `
        + `add the models yourself OUTSIDE the opencodex markers (see the Grok Build guide).${cleanup}`,
    };
  }

  const configPath = join(grokHome, "config.toml");
  const backupPath = join(grokHome, "config.toml.bak-opencodex");
  try {
    const configExisted = existsSync(configPath);
    const rawContent = configExisted ? readFileSync(configPath, "utf8") : "";
    const eol = dominantEol(rawContent);
    const content = applyEol(rawContent, "\n");
    const region = findManagedRegion(content);
    if (region?.orphaned) return orphanedMarkerResult("injection");

    const block = buildGrokManagedBlock(port, models, opts.hostname, userModelAliases(content, region));
    let nextContent: string;
    if (region) {
      nextContent = content.slice(0, region.start) + block + content.slice(region.end);
    } else if (content.length === 0) {
      nextContent = `${block}\n`;
    } else {
      // Exactly ONE separator newline, always. The old rule ("\n\n" when the file lacked a
      // trailing newline) made two different originals — "X" and "X\n" — produce byte-identical
      // files, so strip could not restore both. One newline keeps injection injective: the
      // user's own terminator is preserved verbatim and strip can undo exactly what we added.
      nextContent = `${content}\n${block}\n`;
    }

    const output = applyEol(nextContent, eol);
    if (output === rawContent) {
      return { ok: true, changed: false, message: "Grok config already contains the current opencodex managed block." };
    }
    if (configExisted && !region) copyBackupOnce(configPath, backupPath);
    atomicWriteFile(configPath, output);
    return {
      ok: true,
      changed: true,
      message: region
        ? "Updated the opencodex managed block in Grok config."
        : "Added the opencodex managed block to Grok config.",
    };
  } catch (error) {
    return errorResult("inject", error);
  }
}

export function stripGrokConfig(opts: { grokHome?: string } = {}): GrokInjectResult {
  const grokHome = resolveGrokHome(opts.grokHome);
  if (!isDirectory(grokHome)) {
    return {
      ok: true,
      changed: false,
      message: `Grok home not found at ${grokHome}; no managed config to remove.`,
      skippedReason: "no-grok-home",
    };
  }

  const configPath = join(grokHome, "config.toml");
  if (!existsSync(configPath)) {
    return { ok: true, changed: false, message: "Grok config not found; no managed block to remove." };
  }

  try {
    const rawContent = readFileSync(configPath, "utf8");
    const eol = dominantEol(rawContent);
    const content = applyEol(rawContent, "\n");
    const region = findManagedRegion(content);
    if (!region) {
      return { ok: true, changed: false, message: "No opencodex managed block found in Grok config." };
    }
    if (region.orphaned) return orphanedMarkerResult("cleanup");

    let removalEnd = region.end;
    if (content.startsWith("\n", removalEnd)) removalEnd += 1;
    let prefix = content.slice(0, region.start);
    const restOfFile = content.slice(removalEnd);
    // Undo the single separator newline injection added. Two cases, mirroring inject:
    //   "X\n"  -> "X\n" + "\n" + block  => prefix ends "\n\n", drop one.
    //   "X"    -> "X"   + "\n" + block  => prefix ends "\n" at EOF, drop it.
    // A block the user has appended content after is left alone: we never shrink their bytes.
    if (prefix.endsWith("\n\n")) prefix = prefix.slice(0, -1);
    else if (restOfFile.length === 0 && prefix.endsWith("\n")) prefix = prefix.slice(0, -1);
    const stripped = prefix + restOfFile;
    atomicWriteFile(configPath, applyEol(stripped, eol));

    return {
      ok: true,
      changed: true,
      message: "Removed the opencodex managed block from Grok config.",
    };
  } catch (error) {
    return errorResult("strip", error);
  }
}
/** Decode a TOML basic-string body: JSON-compatible escapes plus TOML's \uXXXX / \UXXXXXXXX. */
function decodeTomlBasicString(body: string): string {
  return body.replace(
    /\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g,
    (whole, esc: string) => {
      if (esc[0] === "u") return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (esc[0] === "U") {
        const code = parseInt(esc.slice(1), 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      switch (esc) {
        case "b": return "\b";
        case "t": return "\t";
        case "n": return "\n";
        case "f": return "\f";
        case "r": return "\r";
        case '"': return '"';
        case "\\": return "\\";
        default: return whole; // invalid escape — keep raw, reservation stays conservative
      }
    },
  );
}
