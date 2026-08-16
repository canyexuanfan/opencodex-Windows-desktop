import { inspectCodexLogs, type CodexLogGuardInspection } from "../codex/log-guard/inspect";

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function fileMetadataLines(report: CodexLogGuardInspection): string[] {
  if (report.externalSqliteHome === null) return [];
  const location = report.externalSqliteHome ? "external sqlite_home" : "CODEX_HOME sqlite_home";
  return [
    `         ${location}; DB ${kib(report.files.databaseBytes)}, WAL ${kib(report.files.walBytes)}, SHM ${kib(report.files.shmBytes)}`,
  ];
}

export function formatCodexLogGuardDoctor(report: CodexLogGuardInspection): string[] {
  const lines = ["Codex diagnostic logs"];

  if (report.schema.state === "unavailable") {
    lines.push("  --     inspection unavailable");
    return lines;
  }
  if (report.schema.state === "missing") {
    lines.push("  --     logs_2.sqlite is not present");
    return lines;
  }
  if (report.schema.state === "unreadable") {
    lines.push("  --     logs_2.sqlite is unreadable; inspection metadata only");
    lines.push(...fileMetadataLines(report));
    lines.push("         checkpointed read-only snapshot; activity rate not measured");
    return lines;
  }
  if (report.schema.state === "unsupported") {
    lines.push("  --     unknown schema; inspection only");
  } else {
    lines.push("  ok     schema compatible");
  }

  lines.push(...fileMetadataLines(report));

  if (report.metrics) {
    lines.push(
      `         ${report.metrics.totalRows} rows; TRACE ${(report.metrics.traceShare * 100).toFixed(1)}%; reclaimable ${kib(report.metrics.reclaimableBytes)}`,
    );
    const top = report.metrics.topTargets[0];
    if (top) lines.push(`         top target ${top.target} (${top.rows} rows)`);
  }

  lines.push("         checkpointed read-only snapshot; activity rate not measured");
  return lines;
}

export interface CodexLogGuardDoctorDeps {
  inspect?: () => CodexLogGuardInspection;
  log?: (line: string) => void;
}

/** Observe-only doctor section. Inspection failures are reported without mutating or failing doctor. */
export function printCodexLogGuardDoctor(deps: CodexLogGuardDoctorDeps = {}): void {
  const inspect = deps.inspect ?? inspectCodexLogs;
  const log = deps.log ?? console.log;
  try {
    for (const line of formatCodexLogGuardDoctor(inspect())) log(line);
  } catch {
    log("Codex diagnostic logs");
    log("  --     inspection unavailable");
  }
}
