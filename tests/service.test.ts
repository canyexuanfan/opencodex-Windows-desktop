import { describe, expect, test } from "bun:test";
import { buildUnit, buildWindowsSchtasksCreateArgs } from "../src/service";

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
