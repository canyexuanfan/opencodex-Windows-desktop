import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getConfigDir } from "../config";
import { interactiveConfirm } from "./interactive-confirm";

const REPO = "lidge-jun/opencodex";
/** Fires exactly once from the first interactive `ocx start`. */
const MARKER = ".star-prompted";

/**
 * True once the one-time star prompt has already fired (marker written). The
 * update prompt uses this to yield on a user's very first run so two prompts
 * never stack on a fresh install.
 */
export function hasStarPromptRun(): boolean {
  try {
    return existsSync(join(getConfigDir(), MARKER));
  } catch {
    return false;
  }
}

/**
 * Whether `gh` is both installed and logged in. Starring goes through the
 * user's own `gh` auth, so an unauthenticated CLI cannot fulfil a "Yes" — in
 * that case the prompt stays silent instead of asking for something it would
 * then fail to do.
 */
function ghAvailable(): boolean {
  const version = spawnSync("gh", ["--version"], { stdio: "ignore", timeout: 3000, windowsHide: true });
  if (version.error || version.status !== 0) return false;
  const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 5000, windowsHide: true });
  return !auth.error && auth.status === 0;
}

function starRepo(): { ok: boolean; error?: string } {
  const r = spawnSync("gh", ["api", "-X", "PUT", `/user/starred/${REPO}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, windowsHide: true });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || "").trim() || `gh exited ${r.status}` };
  return { ok: true };
}

/**
 * First interactive `ocx start`: a one-time "star on GitHub?" question with an
 * explicit Yes/No selector (arrow keys, `y`/`n`, Enter). "No" is highlighted
 * first, so Enter alone declines. On yes, stars the repo via the user's `gh`
 * auth. No-op under the background service, for non-TTY/piped runs, when
 * already prompted, or when `gh` is missing or logged out. Never throws.
 */
export async function maybeShowStarPrompt(): Promise<void> {
  try {
    if (process.env.OCX_SERVICE || !process.stdin.isTTY || !process.stdout.isTTY) return;
    const dir = getConfigDir();
    const marker = join(dir, MARKER);
    if (existsSync(marker)) return;
    if (!ghAvailable()) return; // can't star without an authenticated gh — stay silent and re-check on a later start
    try { mkdirSync(dir, { recursive: true }); writeFileSync(marker, new Date().toISOString()); } catch { /* best-effort */ }

    const yes = await interactiveConfirm({
      question: "\n  \x1b[38;5;141m⭐ Enjoying opencodex? Star it on GitHub?\x1b[0m",
      defaultYes: false,
    });
    if (!yes) return;
    const r = starRepo();
    console.log(r.ok ? "  Thanks for the star! ⭐\n" : `  Couldn't star automatically (${r.error}) — ${REPO}\n`);
  } catch { /* never let the star prompt disrupt startup */ }
}
