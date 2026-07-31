import type { WebContents, WindowOpenHandlerResponse } from "electron";
import { shell } from "electron";
import { isAllowedLoopbackUrl } from "./url-policy.js";
export { isAllowedLoopbackUrl } from "./url-policy.js";
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function installNavigationPolicy(contents: WebContents, expectedOrigin?: string): void {
  contents.setWindowOpenHandler(({ url }): WindowOpenHandlerResponse => {
    if (isAllowedLoopbackUrl(url, expectedOrigin)) {
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
    if (url === "about:blank") return;
    if (!isAllowedLoopbackUrl(url, expectedOrigin)) {
      event.preventDefault();
    }
  });
}
