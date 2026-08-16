/**
 * Server-side thought-signature replay store (issue #1735 follow-up).
 *
 * Gemini issues a thoughtSignature on the function-call part of a response and requires it
 * back when the same call is replayed in a later request. The Responses wire carries the
 * signature in extra_content.google.thought_signature, and a conforming client echoes it on
 * the replay. Real clients (codex-rs 0.144.x, Codex desktop) do NOT echo extra_content:
 * they replay history as bare function_call / custom_tool_call items keyed by call_id.
 * Without the signature Gemini rejects the replayed part with
 * "Function call is missing a thought_signature in functionCall parts".
 *
 * This module is the proxy-side fallback: remember the signature we handed out, keyed by the
 * client-visible call_id, and re-attach it on replay even when the client never echoes it.
 * Values stay opaque (never parsed or re-encoded) and are bounded like the wire metadata.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileAsync, getConfigDir } from "../config";
import type { OcxProviderOpaqueToolCallMetadata } from "../types";
import { isCarryableSignature, responsesExtraContentFromProviderMetadata } from "./provider-opaque-metadata";

const STORE_FILE_NAME = "thought-signature-replay.json";

/** Bound on remembered entries; real signatures are a few hundred bytes, so this stays small. */
const MAX_ENTRIES = 16_384;
/** A signature is needed for the immediate next turn; a long TTL also covers resumed threads. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type StoredEntry = { sig: string; savedAt: number };

let entries = new Map<string, StoredEntry>();
let loaded = false;
let persistChain: Promise<void> = Promise.resolve();

function storePath(): string {
  return join(getConfigDir(), STORE_FILE_NAME);
}

function load(): void {
  if (loaded) return;
  loaded = true;
  let raw: string;
  try {
    raw = readFileSync(storePath(), "utf8");
  } catch {
    return; // First run or unreadable file: start empty.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return;
    }
    const nowMs = Date.now();
    for (const entry of (parsed as { entries: unknown[] }).entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const { callId, sig, savedAt } = entry as { callId?: unknown; sig?: unknown; savedAt?: unknown };
      if (typeof callId !== "string" || typeof sig !== "string" || typeof savedAt !== "number") continue;
      if (savedAt <= nowMs - TTL_MS) continue;
      if (!isCarryableSignature(sig)) continue;
      entries.set(callId, { sig, savedAt });
    }
  } catch {
    // Corrupt store: ignore it; a later remember() rewrites a clean snapshot.
  }
}

function prune(nowMs: number): void {
  for (const [callId, entry] of entries) {
    if (nowMs - entry.savedAt > TTL_MS) entries.delete(callId);
  }
  if (entries.size > MAX_ENTRIES) {
    const sorted = [...entries.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [callId] of sorted.slice(0, sorted.length - MAX_ENTRIES)) entries.delete(callId);
  }
}

function persist(): void {
  persistChain = persistChain
    .then(async () => {
      const snapshot = JSON.stringify({
        version: 1,
        entries: [...entries].map(([callId, entry]) => ({ callId, sig: entry.sig, savedAt: entry.savedAt })),
      });
      await atomicWriteFileAsync(storePath(), snapshot);
    })
    .catch(() => {
      // Best-effort persistence: the in-memory store still serves the running process.
    });
}

/** Record the signature that left the proxy on a function-call response item. */
export function rememberThoughtSignatureForReplay(callId: string, signature: string): void {
  if (!callId || !isCarryableSignature(signature)) return;
  load();
  entries.set(callId, { sig: signature, savedAt: Date.now() });
  prune(Date.now());
  persist();
}

/**
 * Serialize provider metadata onto an outbound Responses function_call item AND remember the
 * signature server-side, so a client that replays the call without echoing extra_content can
 * still be served from the store.
 */
export function rememberAndSerializeExtraContent(
  callId: string,
  metadata: OcxProviderOpaqueToolCallMetadata | undefined,
): { extra_content: { google: { thought_signature: string } } } | undefined {
  const extra = responsesExtraContentFromProviderMetadata(metadata);
  if (extra) rememberThoughtSignatureForReplay(callId, extra.extra_content.google.thought_signature);
  return extra;
}

/** Look up a signature previously handed out for this call_id, if it is still fresh. */
export function lookupReplayThoughtSignature(callId: string): string | undefined {
  if (!callId) return undefined;
  load();
  const entry = entries.get(callId);
  if (!entry) return undefined;
  if (Date.now() - entry.savedAt > TTL_MS) {
    entries.delete(callId);
    return undefined;
  }
  return entry.sig;
}

/** Test seams: clear in-memory state and the loaded flag without touching the file. */
export function resetThoughtSignatureReplayForTests(): void {
  entries = new Map();
  loaded = false;
  persistChain = Promise.resolve();
}

export function thoughtSignatureReplayCountForTests(): number {
  return entries.size;
}

/** Test seam: resolve after the queued snapshot write settles. */
export function flushThoughtSignatureReplayForTests(): Promise<void> {
  return persistChain;
}
