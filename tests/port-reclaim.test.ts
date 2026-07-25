import { describe, expect, test } from "bun:test";
import { parseListenPidsFromNetstat, reclaimListenPort } from "../src/server/port-reclaim";
import { parseTcpQuadsForLocalPort } from "../src/server/windows-tcp-drop";

describe("parseListenPidsFromNetstat", () => {
  test("extracts Windows LISTENING owners for the local port", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:60001        CLOSE_WAIT      18268",
      "  TCP    0.0.0.0:54321          0.0.0.0:0              LISTENING       99",
    ].join("\n");
    expect(parseListenPidsFromNetstat(output, 10100)).toEqual([18268]);
  });

  test("extracts unix netstat -anlp listen PIDs", () => {
    const output = [
      "tcp        0      0 127.0.0.1:10100         0.0.0.0:*               LISTEN      4242/bun",
      "tcp        0      0 127.0.0.1:22            0.0.0.0:*               LISTEN      1/sshd",
    ].join("\n");
    expect(parseListenPidsFromNetstat(output, 10100)).toEqual([4242]);
  });
});

describe("parseTcpQuadsForLocalPort", () => {
  test("collects every TCP row on the local port including non-LISTEN states", () => {
    const output = [
      "  TCP    127.0.0.1:10100        0.0.0.0:0              LISTENING       18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:60001        CLOSE_WAIT      18268",
      "  TCP    127.0.0.1:10100        127.0.0.1:62066        ESTABLISHED     18268",
      "  TCP    127.0.0.1:62066        127.0.0.1:10100        ESTABLISHED     14492",
    ].join("\n");
    expect(parseTcpQuadsForLocalPort(output, 10100)).toEqual([
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "0.0.0.0", remotePort: 0, state: "LISTENING" },
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "127.0.0.1", remotePort: 60001, state: "CLOSE_WAIT" },
      { localAddr: "127.0.0.1", localPort: 10100, remoteAddr: "127.0.0.1", remotePort: 62066, state: "ESTABLISHED" },
    ]);
  });
});

describe("reclaimListenPort", () => {
  test("returns true once the port becomes available", async () => {
    let available = false;
    const killed: number[] = [];
    const pending = reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 500,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      isAvailableFn: async () => available,
      listListenPidsFn: () => (available ? [] : [4242]),
      isAliveFn: () => true,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
        available = true;
      },
      sleepMs: async () => {},
    });
    await expect(pending).resolves.toBe(true);
    expect(killed).toEqual([4242]);
  });

  test("does not kill foreign (non-ocx) listeners", async () => {
    const killed: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      isAvailableFn: async () => false,
      listListenPidsFn: () => [555],
      isAliveFn: () => true,
      verifyOcxFn: () => null,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(false);
    expect(killed).toEqual([]);
  });

  test("ignores dead owner PIDs still listed by the OS", async () => {
    const killed: number[] = [];
    let ticks = 0;
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 80,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: false,
      isAvailableFn: async () => {
        ticks += 1;
        return ticks > 2;
      },
      listListenPidsFn: () => [18268],
      isAliveFn: () => false,
      verifyOcxFn: pid => pid,
      killFn: pid => {
        killed.push(pid);
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(killed).toEqual([]);
  });

  test("resets TCP rows on the local port instead of asking the user to close browsers", async () => {
    let available = false;
    const dropped: number[] = [];
    await expect(reclaimListenPort(10100, "127.0.0.1", {
      timeoutMs: 200,
      intervalMs: 20,
      scanIntervalMs: 20,
      dropTcpRows: true,
      isAvailableFn: async () => available,
      listListenPidsFn: () => [],
      dropTcpFn: port => {
        dropped.push(port);
        available = true;
        return 3;
      },
      sleepMs: async () => {},
    })).resolves.toBe(true);
    expect(dropped).toEqual([10100]);
  });
});
