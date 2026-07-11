import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  DiagnosticsErrorSchema,
  DiagnosticsResultSchema,
  GetBlobResultSchema,
  KvClientMessageSchema,
  McpErrorSchema,
  McpResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  type ExecServerMessage,
  type KvServerMessage,
} from "./gen/agent_pb";
import {
  deleteExec,
  grepExec,
  lsExec,
  readExec,
  rejectDeleteExecForApplyPatch,
  rejectDeleteExecForPolicy,
  rejectGrepExecForPolicy,
  rejectLsExecForPolicy,
  rejectReadExecForPolicy,
  rejectWriteExecForApplyPatch,
  rejectWriteExecForPolicy,
  writeExec,
} from "./native-exec-fs";
import { fetchExec, rejectFetchExecForPolicy, type CursorNativeNetworkDeps } from "./native-exec-network";
import {
  backgroundShellSpawnExec,
  rejectBackgroundShellSpawnExecForPolicy,
  rejectShellExecForPolicy,
  rejectShellStreamExecForPolicy,
  rejectWriteShellStdinExecForPolicy,
  shellExec,
  shellStreamExec,
  writeShellStdinExec,
} from "./native-exec-shell";
import {
  computerUseExec,
  listMcpResourcesExec,
  mcpExec,
  readMcpResourceExec,
  recordScreenExec,
  type CursorNativeToolDeps,
} from "./native-exec-tools";
import { clientBytes, execBytes } from "./native-exec-common";
import type { McpToolDefinition } from "./gen/agent_pb";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";

export type CursorNativeExecDeps = CursorNativeNetworkDeps & CursorNativeToolDeps;

/**
 * Execution context for a Cursor stream: the per-call executors plus the MCP tool definitions
 * advertised to the server via `requestContextResult`. Without `mcpToolDefs`, the server is
 * never told any MCP tools exist, so it never sends `mcpArgs`.
 */
export interface CursorNativeExecContext extends CursorNativeExecDeps {
  mcpToolDefs?: McpToolDefinition[];
  clientToolDefs?: McpToolDefinition[];
  /** Unsafe opt-in escape hatch for Cursor server-driven local fs/shell/fetch execution. */
  unsafeAllowNativeLocalExec?: boolean;
  /** apply_patch is visible for this request; Cursor-native write/delete must not bypass Codex. */
  rejectNativeFileMutations?: boolean;
}

export function cursorUnsafeNativeLocalExecEnabled(input: Pick<CursorNativeExecContext, "unsafeAllowNativeLocalExec"> = {}): boolean {
  return input.unsafeAllowNativeLocalExec === true;
}

/**
 * Content-addressed blob store shared across streams. Bounded: without eviction a long-running
 * proxy accumulates every conversation's prompt blobs forever (unbounded memory) and any stale
 * blob stays servable indefinitely — a cross-conversation contamination enabler if Cursor's
 * server-side state ever references old ids (devlog 260702 P0). Continuation requests re-store
 * their blobs on every turn (`rootPromptMessages` → `storeCursorBlob`), so TTL + cap eviction is
 * safe for live sessions: only genuinely abandoned entries age out.
 */
const BLOB_TTL_MS = 15 * 60 * 1000;
const BLOB_MAX_ENTRIES = 4096;
const blobs = new Map<string, { data: Uint8Array; storedAt: number }>();

function evictStaleBlobs(now: number): void {
  if (blobs.size <= BLOB_MAX_ENTRIES) {
    // TTL sweep only when the map has any chance of stale entries; Map iterates insertion order.
    for (const [k, entry] of blobs) {
      if (now - entry.storedAt <= BLOB_TTL_MS) break;
      blobs.delete(k);
    }
    return;
  }
  // Over cap: drop oldest entries first (insertion order approximates recency because re-stores
  // delete+set to refresh their position).
  const excess = blobs.size - BLOB_MAX_ENTRIES;
  let dropped = 0;
  for (const k of blobs.keys()) {
    if (dropped >= excess) break;
    blobs.delete(k);
    dropped++;
  }
}

function setBlob(k: string, data: Uint8Array): void {
  const now = Date.now();
  blobs.delete(k); // refresh insertion order so live sessions stay newest
  blobs.set(k, { data, storedAt: now });
  evictStaleBlobs(now);
}

function getBlob(k: string): Uint8Array | undefined {
  const entry = blobs.get(k);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > BLOB_TTL_MS) {
    blobs.delete(k);
    return undefined;
  }
  return entry.data;
}

function key(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Store a blob (SHA-256 keyed) in the shared map that `handleCursorNativeKv` serves, and return its
 * blob id. Cursor's `rootPromptMessagesJson`/turn entries are blob IDS, not inline content — the
 * server fetches the bytes back via `getBlobArgs`. Mirrors jawcode `createBlobId`/`storeCursorBlob`.
 */
export function storeCursorBlob(data: Uint8Array): Uint8Array {
  const blobId = new Uint8Array(createHash("sha256").update(data).digest());
  setBlob(key(blobId), data);
  return blobId;
}

export async function handleCursorNativeExec(execMsg: ExecServerMessage, deps: CursorNativeExecContext = {}): Promise<Uint8Array[]> {
  const execCase = execMsg.message.case;
  // THROWAWAY PROBE SCAFFOLD (env-gated; reverted before commit): observe every exec
  // frame so a model tool-call under any providerIdentifier is visible even when the
  // OCX_RESPONSES surfacing filter would hide it from run()'s CursorServerMessage stream.
  if (process.env.OCX_CURSOR_PROBE_PROVIDER) {
    const v = execMsg.message.value as { providerIdentifier?: string; toolName?: string; name?: string } | undefined;
    const extra = execCase === "mcpArgs" ? ` provider=${v?.providerIdentifier} name=${v?.toolName || v?.name}` : "";
    console.error(`[PROBE] execCase=${execCase}${extra}`);
  }
  if (execCase === "requestContextArgs") {
    const tools = [...(deps.mcpToolDefs ?? []), ...(deps.clientToolDefs ?? [])];
    return [execBytes(execMsg, "requestContextResult", create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: create(RequestContextSchema, { tools }) }) },
    }))];
  }
  if (!cursorUnsafeNativeLocalExecEnabled(deps)) {
    if (execCase === "readArgs") return [rejectReadExecForPolicy(execMsg)];
    if (execCase === "writeArgs") return [rejectWriteExecForPolicy(execMsg)];
    if (execCase === "deleteArgs") return [rejectDeleteExecForPolicy(execMsg)];
    if (execCase === "lsArgs") return [rejectLsExecForPolicy(execMsg)];
    if (execCase === "grepArgs") return [rejectGrepExecForPolicy(execMsg)];
    if (execCase === "shellArgs") return [rejectShellExecForPolicy(execMsg)];
    if (execCase === "shellStreamArgs") return rejectShellStreamExecForPolicy(execMsg);
    if (execCase === "backgroundShellSpawnArgs") return [rejectBackgroundShellSpawnExecForPolicy(execMsg)];
    if (execCase === "writeShellStdinArgs") return [rejectWriteShellStdinExecForPolicy(execMsg)];
    if (execCase === "fetchArgs") return [rejectFetchExecForPolicy(execMsg)];
  }
  if (execCase === "readArgs") return [readExec(execMsg)];
  if (execCase === "writeArgs") return [deps.rejectNativeFileMutations ? rejectWriteExecForApplyPatch(execMsg) : writeExec(execMsg)];
  if (execCase === "deleteArgs") return [deps.rejectNativeFileMutations ? rejectDeleteExecForApplyPatch(execMsg) : deleteExec(execMsg)];
  if (execCase === "lsArgs") return [lsExec(execMsg)];
  if (execCase === "grepArgs") return [grepExec(execMsg)];
  if (execCase === "shellArgs") return [shellExec(execMsg)];
  if (execCase === "shellStreamArgs") return shellStreamExec(execMsg);
  if (execCase === "backgroundShellSpawnArgs") return [backgroundShellSpawnExec(execMsg)];
  if (execCase === "writeShellStdinArgs") return [writeShellStdinExec(execMsg)];
  if (execCase === "fetchArgs") return [await fetchExec(execMsg, deps)];
  if (execCase === "mcpArgs" && execMsg.message.value.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER) {
    return [execBytes(execMsg, "mcpResult", create(McpResultSchema, {
      result: {
        case: "error",
        value: create(McpErrorSchema, { error: "Cursor requested a client Responses tool through the native exec channel; bridge suspension is not implemented." }),
      },
    }))];
  }
  if (execCase === "mcpArgs") return [await mcpExec(execMsg, deps)];
  if (execCase === "listMcpResourcesExecArgs") return [await listMcpResourcesExec(execMsg, deps)];
  if (execCase === "readMcpResourceExecArgs") return [await readMcpResourceExec(execMsg, deps)];
  if (execCase === "computerUseArgs") return [await computerUseExec(execMsg, deps)];
  if (execCase === "recordScreenArgs") return [await recordScreenExec(execMsg, deps)];
  if (execCase === "diagnosticsArgs") {
    const path = execMsg.message.value.path;
    return [execBytes(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {
      result: {
        case: "error",
        value: create(DiagnosticsErrorSchema, {
          path,
          error: "Diagnostics are not supported by the opencodex Cursor transport.",
        }),
      },
    }))];
  }
  throw new Error(`Unsupported Cursor native exec case: ${execCase ?? "unknown"}`);
}


export function handleCursorNativeKv(kvMsg: KvServerMessage): Uint8Array {
  if (kvMsg.message.case === "getBlobArgs") {
    const blobData = getBlob(key(kvMsg.message.value.blobId));
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: { case: "getBlobResult", value: create(GetBlobResultSchema, blobData ? { blobData } : {}) },
        }),
      },
    });
  }
  if (kvMsg.message.case === "setBlobArgs") {
    setBlob(key(kvMsg.message.value.blobId), kvMsg.message.value.blobData);
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) },
        }),
      },
    });
  }
  return clientBytes({ message: { case: "kvClientMessage", value: create(KvClientMessageSchema, { id: kvMsg.id }) } });
}
