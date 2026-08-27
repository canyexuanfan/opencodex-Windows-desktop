import { describe, expect, test } from "bun:test";
import { CLI_COMMANDS } from "../src/cli/registry";
import { DISPATCH_ALIASES, DISPATCH_COMMANDS, dispatchCommand, resolveDispatchCommand } from "../src/cli/dispatch";
import type { CliDispatchDeps } from "../src/cli/dispatch";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../src/config";
import { getAccountSet, saveCredential } from "../src/oauth/store";

/** Minimal fake deps. dispatchCommand only touches deps for real command
 * runners, which these tests never invoke, so an empty object is enough. */
const fakeDeps = {} as unknown as CliDispatchDeps;

describe("CLI dispatch command coverage", () => {
  test("every non-hidden registry command is dispatchable", () => {
    const aliasResolved = new Set([...DISPATCH_COMMANDS, ...DISPATCH_ALIASES.keys()]);
    const missing = CLI_COMMANDS.filter(entry => {
      if (entry.hidden) return false;
      // A visible command counts as dispatchable when it is a direct runner
      // key or an alias that resolves to one (setup/eject/remove/model).
      return !aliasResolved.has(entry.name);
    }).map(entry => entry.name);
    expect(missing).toEqual([]);
  });

  test("every dispatch alias resolves to a dispatchable command", () => {
    for (const [alias, target] of DISPATCH_ALIASES) {
      expect(DISPATCH_COMMANDS).toContain(target);
      expect(alias).not.toBe(target);
    }
  });
});

describe("CLI dispatch aliases", () => {
  test("canonical alias pairs resolve to their command", () => {
    expect(DISPATCH_ALIASES.get("setup")).toBe("init");
    expect(DISPATCH_ALIASES.get("eject")).toBe("restore");
    expect(DISPATCH_ALIASES.get("remove")).toBe("uninstall");
    expect(DISPATCH_ALIASES.get("model")).toBe("models");
  });

  test("resolveDispatchCommand maps each alias to its canonical runner key", () => {
    // The same resolver dispatchCommand uses for runner selection, exercised
    // at the resolution level so a regression in the lookup is caught.
    expect(resolveDispatchCommand("setup")).toBe("init");
    expect(resolveDispatchCommand("eject")).toBe("restore");
    expect(resolveDispatchCommand("remove")).toBe("uninstall");
    expect(resolveDispatchCommand("model")).toBe("models");
    // Canonical names resolve to themselves; unknown names resolve undefined.
    expect(resolveDispatchCommand("init")).toBe("init");
    expect(resolveDispatchCommand("definitely-not-a-command")).toBeUndefined();
    expect(resolveDispatchCommand(undefined)).toBeUndefined();
  });

  test("resolveDispatchCommand rejects inherited Object property names", () => {
    // commandRunners is a normal object; inherited names (__proto__,
    // constructor, toString) must not resolve as valid commands.
    expect(resolveDispatchCommand("__proto__")).toBeUndefined();
    expect(resolveDispatchCommand("constructor")).toBeUndefined();
    expect(resolveDispatchCommand("toString")).toBeUndefined();
  });
});

describe("dispatchCommand exit codes", () => {
  test("returns 0 for help forms", async () => {
    expect(await dispatchCommand({ kind: "help", command: "help", args: ["help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "help", command: "--help", args: ["--help"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "help", command: "-h", args: ["-h"] }, fakeDeps)).toBe(0);
    expect(await dispatchCommand({ kind: "command", command: undefined, args: [] }, fakeDeps)).toBe(0);
  });

  test("returns 1 for an unknown command", async () => {
    const head = { kind: "command" as const, command: "definitely-not-a-command", args: ["definitely-not-a-command"] };
    expect(await dispatchCommand(head, fakeDeps)).toBe(1);
  });

  test("returns 1 for inherited Object property names", async () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const head = { kind: "command" as const, command: name, args: [name] };
      expect(await dispatchCommand(head, fakeDeps), `${name} must be unknown`).toBe(1);
    }
  });

  test("forwards service arguments and preserves handler exit codes", async () => {
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 7;
      const successCalls: string[][] = [];
      const successDeps = {
        ...fakeDeps,
        args: ["service", "install", "--scheduler"],
        serviceCommand: async (...args: string[]) => {
          successCalls.push(args);
        },
      };

      expect(await dispatchCommand(
        { kind: "command", command: "service", args: successDeps.args },
        successDeps,
      )).toBe(0);
      expect(successCalls).toEqual([["install", "--scheduler"]]);

      for (const expected of [1, 2]) {
        const calls: string[][] = [];
        const deps = {
          ...fakeDeps,
          args: ["service", "install", "--scheduler"],
          serviceCommand: async (...args: string[]) => {
            calls.push(args);
            process.exitCode = expected;
          },
        };

        expect(await dispatchCommand(
          { kind: "command", command: "service", args: deps.args },
          deps,
        )).toBe(expected);
        expect(calls).toEqual([["install", "--scheduler"]]);
      }
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
  });
});

describe("logout parses argv before touching the credential store", () => {
  /**
   * `ocx logout --json` used to lowercase `--json`, pass it to removeCredential as a provider
   * name, print "Logged out of --json." and exit 0. A caller that can only see the exit code
   * got a success for an operation that removed nothing.
   *
   * The severity is not "a wasted call". `normalizeAuthStore` copies every top-level key it
   * finds, so a hand-edited, legacy, or corrupted auth.json carrying a `--json` key would lose
   * that key's active account -- and the key itself if it was the last account. These
   * assertions therefore compare the store FILE before and after, which proves the store was
   * never reached rather than trusting a stubbed function.
   *
   * Safe against the developer's real store: `tests/preload.ts` sandboxes HOME and
   * OPENCODEX_HOME for every invocation, wrapped or bare, so this writes to a temp home.
   */
  const authPath = (): string => join(getConfigDir(), "auth.json");
  const snapshot = (): string | null => existsSync(authPath()) ? readFileSync(authPath(), "utf8") : null;

  const runLogout = async (args: string[]): Promise<{ code: number; out: string[]; err: string[]; before: string | null; after: string | null }> => {
    const out: string[] = [];
    const err: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...v: unknown[]) => out.push(v.join(" "));
    console.error = (...v: unknown[]) => err.push(v.join(" "));
    const before = snapshot();
    try {
      const argv = ["logout", ...args];
      const code = await dispatchCommand(
        { kind: "command", command: "logout", args: argv },
        { ...fakeDeps, args: argv } as unknown as CliDispatchDeps,
      );
      return { code, out, err, before, after: snapshot() };
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  test("a flag is never read as a provider name and leaves the store byte-identical", async () => {
    const result = await runLogout(["--json"]);
    expect(result.code).toBe(2);
    expect(result.after).toEqual(result.before);
    expect(result.out.join("")).not.toContain("Logged out");
  });

  test("an omitted provider is a usage error, not a no-op success", async () => {
    const result = await runLogout([]);
    expect(result.code).toBe(2);
    expect(result.after).toEqual(result.before);
  });

  test("an unknown option is rejected and the store is untouched", async () => {
    const result = await runLogout(["claude", "--wat"]);
    expect(result.code).toBe(2);
    expect(result.after).toEqual(result.before);
  });

  test("extra positionals are a usage error", async () => {
    const result = await runLogout(["claude", "gemini"]);
    expect(result.code).toBe(2);
    expect(result.after).toEqual(result.before);
  });

  test("a provider with no stored credential is not-found, not usage", async () => {
    // 4 rather than 2: the call was well-formed, the thing simply is not there. Collapsing
    // those two into one code is what made the account family unscriptable (#2698).
    const result = await runLogout(["gemini", "--json"]);
    expect(result.code).toBe(4);
    expect(result.after).toEqual(result.before);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, removed: false, reason: "not_found" });
  });

  test("a stored provider is removed and reported in both modes", async () => {
    await saveCredential("claude", { access: "a", refresh: "r", expires: Date.now() + 60_000 });
    expect(getAccountSet("claude")).not.toBeNull();

    const human = await runLogout(["claude"]);
    expect(human.code).toBe(0);
    expect(human.out.join("")).toContain("Logged out of claude.");
    expect(getAccountSet("claude")).toBeNull();

    // Order-independent, and idempotent: a second logout is now a clean not-found.
    await saveCredential("claude", { access: "a", refresh: "r", expires: Date.now() + 60_000 });
    const json = await runLogout(["--json", "claude"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ ok: true, provider: "claude", removed: true });
    expect(getAccountSet("claude")).toBeNull();
  });
});
