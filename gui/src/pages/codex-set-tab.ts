import type { KeyboardEvent } from "react";

/**
 * Tab state for the Codex Set page, shaped exactly like Logs/Debug: two exclusive
 * tabpanels whose choice lives in the hash, not in component state alone. That is
 * what makes the tab survive a refresh, a bookmark, and back/forward — and it is
 * the pattern devlog 004 §A3 identifies as the one the ask actually names.
 */
export type CodexSetTab = "multiauth" | "prompt";

export function readCodexSetTabFromHash(): CodexSetTab {
  return window.location.hash.replace(/^#\/?/, "") === "codex-set/prompt" ? "prompt" : "multiauth";
}

export function selectCodexSetTab(next: CodexSetTab): void {
  window.location.hash = next === "prompt" ? "codex-set/prompt" : "codex-set";
}

export function codexSetTabKeyDown(e: KeyboardEvent): void {
  if (e.key === "ArrowLeft" || e.key === "Home") {
    e.preventDefault();
    selectCodexSetTab("multiauth");
    document.getElementById("codex-set-tab-multiauth")?.focus();
  } else if (e.key === "ArrowRight" || e.key === "End") {
    e.preventDefault();
    selectCodexSetTab("prompt");
    document.getElementById("codex-set-tab-prompt")?.focus();
  }
}

