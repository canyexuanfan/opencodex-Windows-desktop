if (
  process.env.OPENCODEX_DESKTOP !== "1"
  || process.env.OPENCODEX_DESKTOP_MODE !== "1"
  || process.env.OPENCODEX_DESKTOP_VERSION !== "0.1.7"
  || process.env.OPENCODEX_DESKTOP_BUILD_REVISION !== "0"
) {
  console.error(JSON.stringify({
    desktop: process.env.OPENCODEX_DESKTOP,
    mode: process.env.OPENCODEX_DESKTOP_MODE,
    version: process.env.OPENCODEX_DESKTOP_VERSION,
    buildRevision: process.env.OPENCODEX_DESKTOP_BUILD_REVISION,
  }));
  process.exit(22);
}

console.log(JSON.stringify({
  type: "ready",
  pid: process.pid,
  port: 37694,
  hostname: "127.0.0.1",
  version: "test",
}));

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {
  console.log(JSON.stringify({ type: "stopped" }));
  process.exit(0);
});
process.stdin.resume();
