import { describe, expect, test } from "bun:test";
import { wslAutomountRoot, listWslWindowsCodexHomes } from "../src/codex/home";
import { isWindowsInteropDir } from "../src/codex/shim";

describe("wsl.conf automount root", () => {
  test("defaults to /mnt when wsl.conf is absent or silent", () => {
    expect(wslAutomountRoot({ wslConf: null })).toBe("/mnt");
    expect(wslAutomountRoot({ wslConf: "[boot]\nsystemd=true\n" })).toBe("/mnt");
    expect(wslAutomountRoot({ wslConf: "[automount]\nenabled = true\n" })).toBe("/mnt");
  });

  test("parses a custom root with quotes, comments, and trailing slashes", () => {
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = /custom\n" })).toBe("/custom");
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = \"/custom/\"  # comment\n" })).toBe("/custom");
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = '/'\n" })).toBe("/");
    // root outside [automount] is ignored
    expect(wslAutomountRoot({ wslConf: "[boot]\nroot = /nope\n" })).toBe("/mnt");
    // relative values are invalid -> default
    expect(wslAutomountRoot({ wslConf: "[automount]\nroot = mnt\n" })).toBe("/mnt");
  });

  test("isWindowsInteropDir follows the custom root", () => {
    expect(isWindowsInteropDir("/custom/c/Users/jun", "/custom")).toBe(true);
    expect(isWindowsInteropDir("/mnt/c/Users/jun", "/custom")).toBe(false);
    expect(isWindowsInteropDir("/c/Users/jun", "/")).toBe(true);
    expect(isWindowsInteropDir("/home/jun", "/")).toBe(false);
  });

  test("listWslWindowsCodexHomes derives Users root from the automount root", () => {
    const seen: string[] = [];
    const homes = listWslWindowsCodexHomes({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      wslConf: "[automount]\nroot = /win\n",
      existsSync: (p: string) => {
        seen.push(p);
        return p === "/win/c/Users" || p === "/win/c/Users/jun/.codex/config.toml";
      },
      readdirSync: () => ["jun"],
      statSync: (() => ({ isDirectory: () => true })) as never,
      realpathSync: (p: string) => p,
    });
    expect(seen[0]).toBe("/win/c/Users");
    expect(homes).toEqual(["/win/c/Users/jun/.codex"]);
  });
});
