import { isIP } from "node:net";
import { getProviderRegistryEntry } from "../providers/registry";
import type { OcxProviderConfig } from "../types";

const BLOCKED_METADATA_HOSTS = new Set([
  "instance-data.ec2.internal",
  "metadata.azure.internal",
  "metadata.google.internal",
]);

const BLOCKED_METADATA_IPV4 = new Set([
  "100.100.100.200",
  "169.254.169.254",
  "169.254.170.2",
]);

const BLOCKED_METADATA_IPV6 = new Set([
  "fd00:ec2::254",
]);

type DestinationKind =
  | "public"
  | "hostname"
  | "localhost"
  | "loopback"
  | "private"
  | "link-local"
  | "unspecified"
  | "metadata";

interface DestinationAssessment {
  kind: DestinationKind;
  detail: string;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(part => Number(part));
  return octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function classifyIpv4(hostname: string): DestinationAssessment {
  if (BLOCKED_METADATA_IPV4.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
  const octets = parseIpv4(hostname);
  if (!octets) return { kind: "public", detail: "public IP" };
  const [a, b] = octets;
  if (a === 127) return { kind: "loopback", detail: "loopback address" };
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
    return { kind: "private", detail: "private-network address" };
  }
  if (a === 169 && b === 254) return { kind: "link-local", detail: "link-local address" };
  if (a === 0) return { kind: "unspecified", detail: "unspecified address" };
  return { kind: "public", detail: "public IP" };
}

function firstIpv6Hextet(hostname: string): number | null {
  const head = hostname.split(":")[0];
  if (!head) return 0;
  const parsed = Number.parseInt(head, 16);
  return Number.isNaN(parsed) ? null : parsed;
}

function classifyIpv6(hostname: string): DestinationAssessment {
  if (BLOCKED_METADATA_IPV6.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
  const mappedIpv4 = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mappedIpv4) return classifyIpv4(mappedIpv4);
  if (hostname === "::1") return { kind: "loopback", detail: "loopback address" };
  if (hostname === "::") return { kind: "unspecified", detail: "unspecified address" };
  const hextet = firstIpv6Hextet(hostname);
  if (hextet === null) return { kind: "public", detail: "public IP" };
  if (hextet >= 0xfc00 && hextet <= 0xfdff) return { kind: "private", detail: "private-network address" };
  if (hextet >= 0xfe80 && hextet <= 0xfebf) return { kind: "link-local", detail: "link-local address" };
  return { kind: "public", detail: "public IP" };
}

function assessDestination(baseUrl: string): DestinationAssessment | null {
  try {
    const parsed = new URL(baseUrl.trim());
    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname) return null;
    if (BLOCKED_METADATA_HOSTS.has(hostname)) return { kind: "metadata", detail: "blocked metadata endpoint" };
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return { kind: "localhost", detail: "localhost destination" };
    }
    const ipKind = isIP(hostname);
    if (ipKind === 4) return classifyIpv4(hostname);
    if (ipKind === 6) return classifyIpv6(hostname);
    return { kind: "hostname", detail: "hostname destination" };
  } catch {
    return null;
  }
}

function registryAllowsPrivateNetwork(name: string): boolean {
  return getProviderRegistryEntry(name)?.allowPrivateNetworkByDefault === true;
}

export function providerDestinationConfigError(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): string | null {
  const assessment = assessDestination(provider.baseUrl);
  if (!assessment) return null;
  if (assessment.kind === "public" || assessment.kind === "hostname") return null;
  if (assessment.kind === "metadata") return "baseUrl targets a blocked metadata endpoint";
  if (registryAllowsPrivateNetwork(name)) return null;
  if (provider.allowPrivateNetwork === true) return null;
  return `baseUrl points to a ${assessment.detail}; set allowPrivateNetwork:true only for intentionally local/self-hosted providers`;
}

export function assertProviderDestinationAllowed(name: string, provider: Pick<OcxProviderConfig, "baseUrl" | "allowPrivateNetwork">): void {
  const error = providerDestinationConfigError(name, provider);
  if (error) throw new Error(`provider ${name} ${error}`);
}
