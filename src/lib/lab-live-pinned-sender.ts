import { pinnedHttpGet, pinnedHttpPost } from "./pinned-http";
import type { LabCredentialLeaseV1, LabPinnedSender } from "../lab/live/types";

/**
 * Trusted credential/transport owner. Secret headers exist only in this non-Lab module and are
 * consumed directly by the pinned HTTP primitive; they are never returned to Lab code.
 */
export function createLabAuthorizedPinnedSender(
  authorize: (lease: LabCredentialLeaseV1) => Promise<HeadersInit> | HeadersInit,
): LabPinnedSender {
  return async (lease, destination, pinned, request, signal, limits) => {
    const headers = await authorize(lease);
    const url = `${destination.scheme}://${destination.host}:${destination.port}${destination.basePath}${request.path}`;
    const options = {
      headers,
      maxBytes: limits.maxOutputBytes,
      idleTimeoutMs: Math.min(limits.firstByteTimeoutMs, limits.inactivityTimeoutMs),
      rejectUnauthorized: true,
      context: "Lab provider response",
    };
    const response = request.method === "POST"
      ? await pinnedHttpPost(url, pinned, request.body ?? "", signal, options)
      : await pinnedHttpGet(url, pinned, signal, options);
    const body = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => { responseHeaders[key.toLowerCase()] = value; });
    return { status: response.status, headers: responseHeaders, body };
  };
}
