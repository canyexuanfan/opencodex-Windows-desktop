import type { OcxProviderConfig } from "../../types";
import type { CursorClientMessage } from "./types";

export type CursorNativeExecMode = "off" | "codex-sandbox" | "on";

/** Codex permissions template marker, e.g. "`sandbox_mode` is `danger-full-access`". */
export const CURSOR_SANDBOX_FULL_ACCESS_RE = /sandbox_mode[^\n]{0,80}danger-full-access/i;

/**
 * Config-owner-selected policy; explicit mode wins, legacy boolean maps to "on".
 * The UNSET default is "off". `nativeLocalExec: "on"` is the only non-legacy setting that
 * authorizes Cursor server-driven local read/write/delete/ls/grep/shell/fetch execution.
 * `nativeLocalExec: "codex-sandbox"` is kept as a recognized legacy/deprecated spelling but is
 * fail-closed: opencodex has no trustworthy per-request attestation that caller-supplied
 * Responses instructions/system/developer prose reflects a real Codex sandbox state.
 */
export function resolveCursorNativeExecMode(provider: OcxProviderConfig): CursorNativeExecMode {
  const mode = provider.nativeLocalExec;
  if (mode === "off" || mode === "codex-sandbox" || mode === "on") return mode;
  return provider.unsafeAllowNativeLocalExec === true ? "on" : "off";
}

/**
 * True when the request itself declares the Codex full-access sandbox. Carriers are the
 * system/instructions entries and developer-role messages ONLY. This is diagnostic/context
 * metadata; request text is caller-controlled and never authorizes native local exec.
 */
export function cursorRequestDeclaresFullAccess(
  request: { system: string[]; messages: Array<{ role: string; content: string }> },
): boolean {
  for (const entry of request.system) {
    if (CURSOR_SANDBOX_FULL_ACCESS_RE.test(entry)) return true;
  }
  for (const message of request.messages) {
    if (message.role === "developer" && CURSOR_SANDBOX_FULL_ACCESS_RE.test(message.content)) return true;
  }
  return false;
}

/** Effective per-request allowance: only server-local config opt-in enables native exec. */
export function effectiveCursorNativeExecAllow(provider: OcxProviderConfig, requestDeclaresFullAccess: boolean): boolean {
  const mode = resolveCursorNativeExecMode(provider);
  void requestDeclaresFullAccess;
  return mode === "on";
}

export const CURSOR_EXEC_CASES_DENIED = [
  "readArgs",
  "lsArgs",
  "grepArgs",
  "writeArgs",
  "deleteArgs",
  "shellArgs",
  "shellStreamArgs",
  "diagnosticsArgs",
  "mcpArgs",
  "fetchArgs",
  "recordScreenArgs",
  "computerUseArgs",
  "unknownExecCase",
] as const;

export type CursorDeniedExecCase = (typeof CURSOR_EXEC_CASES_DENIED)[number];

export function cursorExecDeniedMessage(execCase: string): string {
  return [
    `Cursor legacy mock transport cannot execute ${execCase}.`,
    "Production Cursor requests use the live protobuf native exec bridge.",
    "The legacy mock path returns a non-executing placeholder for tests only.",
  ].join(" ");
}

export function cursorExecResult(requestId: string, execCase: string): CursorClientMessage {
  if (execCase === "requestContextArgs") {
    return {
      type: "exec_result",
      requestId,
      ok: true,
      message: "Cursor request context is empty in legacy mock transport mode.",
    };
  }
  return {
    type: "exec_result",
    requestId,
    ok: false,
    message: cursorExecDeniedMessage(execCase),
  };
}
