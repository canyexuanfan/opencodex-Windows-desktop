console.log(JSON.stringify({
  type: "ready",
  pid: process.pid,
  port: 37693,
  hostname: "127.0.0.1",
  version: "test",
}));

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  const lines = input.split(/\r?\n/);
  input = lines.pop() ?? "";
  if (lines.some(line => line.trim() === "stop")) process.exit(1);
});
process.stdin.resume();
