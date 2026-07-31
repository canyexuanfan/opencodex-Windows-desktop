import type { WebContents, WindowOpenHandlerResponse } from "electron";
import { shell } from "electron";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function isAllowedLoopbackUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && url.port.length > 0;
  } catch {
    return false;
  }
}

export function installNavigationPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }): WindowOpenHandlerResponse => {
    if (isAllowedLoopbackUrl(url)) {
      return { action: "allow" };
    }

    try {
      const parsed = new URL(url);
      if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      // Invalid or unsupported URLs are intentionally ignored.
    }
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (!isAllowedLoopbackUrl(url)) {
      event.preventDefault();
    }
  });
}
