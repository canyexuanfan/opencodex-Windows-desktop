/**
 * Shared management-plane client for headless CLI commands.
 *
 * [Decision Log]
 * - 목적과 의도: GUI가 사용하는 관리 기능을 CLI에서도 같은 검증과 저장 경로로 제공한다.
 * - 기존 구현 및 제약 조건: 관리 API에 이미 도메인 검증과 live-config 갱신이 있으나 CLI마다 fetch를 복제했다.
 * - 검토한 주요 대안: config.json 직접 수정, 각 CLI 모듈별 fetch 구현, 공용 관리 API client.
 * - 선택한 방식: identity-checked live proxy를 찾은 뒤 공용 client로 관리 API를 호출한다.
 * - 다른 대안 대신 이 방식을 선택한 이유: GUI/CLI의 검증 규칙이 갈라지지 않고 fallback port도 안전하게 찾는다.
 * - 장점, 단점 및 영향: 동작 일관성이 높아지는 대신 live 관리 명령은 실행 중인 proxy가 필요하다.
 */
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";

export interface RuntimeApiDeps {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class CliUsageError extends Error {
  constructor(message: string, readonly usage?: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class RuntimeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

export async function runtimeBaseUrl(deps: RuntimeApiDeps = {}): Promise<string> {
  if (deps.baseUrl) return deps.baseUrl.replace(/\/$/, "");
  const live = await findLiveProxy();
  if (!live) throw new RuntimeApiError("Proxy is not running. Start it with: ocx start", 503, null);
  return `http://${probeHostname(live.hostname)}:${live.port}`;
}

function responseMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["error", "message", "detail"]) {
      if (typeof record[key] === "string" && record[key]) return record[key];
    }
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 400);
  return `Management request failed (${status})`;
}

export async function runtimeRequest<T = unknown>(
  path: string,
  init: RequestInit = {},
  deps: RuntimeApiDeps = {},
): Promise<T> {
  const baseUrl = await runtimeBaseUrl(deps);
  const headers = runningProxyUpdateHeaders();
  for (const [key, value] of new Headers(init.headers).entries()) headers.set(key, value);
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers });
  } catch (error) {
    throw new RuntimeApiError(
      `Management API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      503,
      null,
    );
  }
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); }
    catch { body = text; }
  }
  if (!response.ok) throw new RuntimeApiError(responseMessage(body, response.status), response.status, body);
  return body as T;
}

export function takeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

export function takeOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${flag} requires a value`);
  args.splice(index, 2);
  return value;
}

export function takeBooleanOption(args: string[], flag: string): boolean | undefined {
  const raw = takeOption(args, flag);
  if (raw === undefined) return undefined;
  if (["on", "true", "yes", "1", "enabled"].includes(raw.toLowerCase())) return true;
  if (["off", "false", "no", "0", "disabled"].includes(raw.toLowerCase())) return false;
  throw new CliUsageError(`${flag} must be on or off`);
}

export function takeIntegerOption(args: string[], flag: string, options: { min?: number } = {}): number | undefined {
  const raw = takeOption(args, flag);
  if (raw === undefined) return undefined;
  const value = Number(raw.replace(/[_,]/g, ""));
  if (!Number.isInteger(value) || value < (options.min ?? Number.MIN_SAFE_INTEGER)) {
    throw new CliUsageError(`${flag} must be an integer${options.min !== undefined ? ` >= ${options.min}` : ""}`);
  }
  return value;
}

export function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))];
}

export function rejectArgs(args: string[], usage: string): void {
  if (args.length > 0) throw new CliUsageError(`Unexpected argument(s): ${args.join(" ")}`, usage);
}

export function printData(value: unknown, wantsJson: boolean, lines?: string[]): void {
  if (wantsJson || !lines) console.log(JSON.stringify(value, null, 2));
  else for (const line of lines) console.log(line);
}

/** Compact human view for safe management DTOs; JSON remains available for complete fidelity. */
export function summaryLines(value: unknown, prefix = "", depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 1) return [`${prefix || "value"}: ${String(value)}`];
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) {
      const scalar = child.every(item => item === null || ["string", "number", "boolean"].includes(typeof item));
      lines.push(`${label}: ${scalar ? child.join(", ") || "none" : `${child.length} item(s)`}`);
    } else if (child && typeof child === "object" && depth < 1) {
      lines.push(...summaryLines(child, label, depth + 1));
    } else {
      lines.push(`${label}: ${child === null || child === undefined || child === "" ? "-" : String(child)}`);
    }
  }
  return lines;
}

export async function runCliAction(action: () => Promise<void>): Promise<number> {
  try {
    await action();
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`Error: ${error.message}`);
      if (error.usage) console.error(error.usage);
      return 2;
    }
    if (error instanceof RuntimeApiError) {
      console.error(`Error: ${error.message}`);
      return error.status === 404 ? 4 : error.status === 409 ? 5 : 1;
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
