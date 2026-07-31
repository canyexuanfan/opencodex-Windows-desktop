export const DESKTOP_HOSTNAME = "127.0.0.1" as const;

export type DesktopReadyMessage = {
  readonly type: "ready";
  readonly pid: number;
  readonly port: number;
  readonly hostname: typeof DESKTOP_HOSTNAME;
  readonly version: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDesktopReadyMessage(value: unknown): value is DesktopReadyMessage {
  if (!isRecord(value)) return false;
  return value.type === "ready"
    && Number.isSafeInteger(value.pid)
    && Number(value.pid) > 0
    && Number.isInteger(value.port)
    && Number(value.port) > 0
    && Number(value.port) <= 65535
    && value.hostname === DESKTOP_HOSTNAME
    && typeof value.version === "string"
    && value.version.trim().length > 0;
}

export function formatDesktopReadyMessage(message: DesktopReadyMessage): string {
  if (!isDesktopReadyMessage(message)) throw new Error("invalid desktop ready message");
  return JSON.stringify(message);
}

/** Parse exactly one stdout line; ordinary logs and malformed JSON are not ready. */
export function parseDesktopReadyLine(line: string): DesktopReadyMessage | null {
  try {
    const parsed: unknown = JSON.parse(line.trim());
    return isDesktopReadyMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
