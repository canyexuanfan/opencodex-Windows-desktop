import { assessUrlDestination } from "../../lib/destination-policy";
import { localFingerprint } from "../digest";
import { readInstallationSalt } from "../subject/installation-salt";
import type { DnsResolver, LabDestinationV1 } from "./types";

export class LabDestinationError extends Error {
  override readonly name = "LabDestinationError";
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function normalizeBasePath(pathname: string): string {
  if (!pathname || pathname === "/") return "";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function destinationFingerprintValue(snapshot: {
  scheme: string;
  host: string;
  port: number;
  basePath: string;
}): Record<string, unknown> {
  return {
    scheme: snapshot.scheme,
    host: snapshot.host,
    port: snapshot.port,
    basePath: snapshot.basePath,
  };
}

export interface CreateDestinationOptions {
  baseUrl: string;
  allowPrivateNetwork?: boolean;
  labRunApproval?: boolean;
  resolve?: DnsResolver;
  configDir?: string;
}

/** Create an immutable destination snapshot from provider baseUrl with DNS policy checks. */
export async function createLabDestination(
  opts: CreateDestinationOptions,
): Promise<LabDestinationV1> {
  let parsed: URL;
  try {
    parsed = new URL(opts.baseUrl);
  } catch {
    throw new LabDestinationError("invalid provider baseUrl", "harness_failure");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LabDestinationError("unsupported URL scheme", "harness_failure");
  }
  const assessment = assessUrlDestination(parsed.toString());
  if (assessment?.kind === "metadata" || assessment?.kind === "link-local" || assessment?.kind === "unspecified") {
    throw new LabDestinationError(`blocked destination: ${assessment.detail}`, "harness_failure");
  }
  const privateNetwork = assessment?.kind === "private" || assessment?.kind === "loopback" || assessment?.kind === "localhost";
  if (privateNetwork && (!opts.allowPrivateNetwork || !opts.labRunApproval)) {
    throw new LabDestinationError("private network requires allowPrivateNetwork and labRunApproval", "harness_failure");
  }

  const resolve = opts.resolve ?? defaultResolver;
  const addresses = await resolve(parsed.hostname);
  if (addresses.length === 0) {
    throw new LabDestinationError("DNS resolution returned no addresses", "network_blocked");
  }

  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:" ? 443 : 80;
  const snapshot = {
    scheme: parsed.protocol === "https:" ? "https" as const : "http" as const,
    host: parsed.hostname.toLowerCase(),
    port,
    basePath: normalizeBasePath(parsed.pathname),
    sniHost: parsed.hostname.toLowerCase(),
    addresses: Object.freeze(addresses.map((a) => Object.freeze({ ...a }))),
    privateNetwork,
  };
  const salt = readInstallationSalt(opts.configDir);
  const fingerprint = localFingerprint("endpoint", destinationFingerprintValue(snapshot), salt);
  return Object.freeze({ ...snapshot, fingerprint });
}

/** Fail closed when a re-resolution does not match the immutable snapshot. */
export function assertDestinationAddressSet(
  destination: LabDestinationV1,
  addresses: Array<{ address: string; family: 4 | 6 }>,
): void {
  const a = [...destination.addresses].map((x) => `${x.family}:${x.address}`).sort().join(",");
  const b = [...addresses].map((x) => `${x.family}:${x.address}`).sort().join(",");
  if (a !== b) {
    throw new LabDestinationError("destination address set mismatch", "destination_mismatch");
  }
}

export function assertHostSniMatch(destination: LabDestinationV1, host: string, sni?: string): void {
  const normalized = host.toLowerCase();
  if (normalized !== destination.host) {
    throw new LabDestinationError("host mismatch", "host_sni_mismatch");
  }
  if (sni !== undefined && sni.toLowerCase() !== destination.sniHost) {
    throw new LabDestinationError("SNI mismatch", "host_sni_mismatch");
  }
}

async function defaultResolver(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const { lookup } = await import("node:dns/promises");
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 as const : 4 as const,
  }));
}
