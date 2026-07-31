const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function isAllowedLoopbackUrl(rawUrl: string, expectedOrigin?: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (!(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.port.length > 0)) return false;
    return expectedOrigin === undefined || url.origin === expectedOrigin;
  } catch {
    return false;
  }
}
