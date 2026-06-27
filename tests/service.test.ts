import { describe, expect, test } from "bun:test";
import { buildUnit, buildWindowsSchtasksCreateArgs } from "../src/service";

const root = new URL("../", import.meta.url);

async function readText(path: string): Promise<string> {
  return await Bun.file(new URL(path, root)).text();
}

describe("systemd service unit", () => {
  test("uses unquoted append targets for service logs", () => {
    const unit = buildUnit();

    expect(unit).toContain("StandardOutput=append:");
    expect(unit).toContain("StandardError=append:");
    expect(unit).not.toContain('StandardOutput="append:');
    expect(unit).not.toContain('StandardError="append:');
  });
});

describe("Windows service task", () => {
  test("builds schtasks create args without shell interpolation", () => {
    const script = "C:\\Users\\a&b\\.opencodex\\opencodex-service.cmd";
    const args = buildWindowsSchtasksCreateArgs(script);

    expect(args).toContain("/create");
    expect(args).toContain("/tr");
    expect(args[args.indexOf("/tr") + 1]).toBe(`"${script}"`);
    expect(args.join(" ")).toContain("a&b");
  });
});

describe("service lifecycle cleanup ordering", () => {
  test("direct service stop kills the tracked proxy before restoring native Codex", async () => {
    const service = await readText("src/service.ts");
    const stopCase = service.slice(service.indexOf('case "stop":'), service.indexOf('case "status":'));

    expect(stopCase).toContain("ops.stop();");
    expect(stopCase).toContain("stopTrackedProxyForServiceCommand();");
    expect(stopCase).toContain("restoreNativeCodex();");
    expect(stopCase.indexOf("ops.stop();")).toBeLessThan(stopCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(stopCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(stopCase.indexOf("restoreNativeCodex();"));
  });

  test("direct service uninstall kills the tracked proxy before deleting service assets", async () => {
    const service = await readText("src/service.ts");
    const uninstallCase = service.slice(service.indexOf('case "uninstall":'), service.indexOf("default:"));

    expect(uninstallCase).toContain("ops.stop();");
    expect(uninstallCase).toContain("stopTrackedProxyForServiceCommand();");
    expect(uninstallCase).toContain("ops.uninstall();");
    expect(uninstallCase).toContain("restoreNativeCodex();");
    expect(uninstallCase.indexOf("ops.stop();")).toBeLessThan(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();"));
    expect(uninstallCase.indexOf("stopTrackedProxyForServiceCommand();")).toBeLessThan(uninstallCase.indexOf("ops.uninstall();"));
    expect(uninstallCase.indexOf("ops.uninstall();")).toBeLessThan(uninstallCase.indexOf("restoreNativeCodex();"));
  });

  test("service cleanup uses the shared process-tree killer and clears the pid file", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain('import { getConfigDir, readPid, removePid } from "./config";');
    expect(service).toContain('import { killProxy } from "./process-control";');
    expect(service).toContain("function stopTrackedProxyIfRunning(): boolean");
    expect(service).toContain("if (!pid) return false;");
    expect(service).toContain("killProxy(pid);");
    expect(service).toContain("removePid(pid);");
  });

  test("service command cleanup logs kill failures without skipping restore/delete", async () => {
    const service = await readText("src/service.ts");

    expect(service).toContain("function stopTrackedProxyForServiceCommand(): boolean");
    expect(service).toContain("catch (err)");
    expect(service).toContain("Failed to stop proxy");
    expect(service).toContain("return false;");
  });
});
