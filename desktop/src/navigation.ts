import type { WebContents, WindowOpenHandlerResponse } from "electron";
import { shell } from "electron";
import { isAllowedLoopbackUrl } from "./url-policy.js";
export { isAllowedLoopbackUrl } from "./url-policy.js";
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export type NavigationPolicy = {
  setExpectedOrigin: (origin: string | undefined) => void;
  dispose: () => void;
};

export function installNavigationPolicy(contents: WebContents, expectedOrigin?: string): NavigationPolicy {
  let activeOrigin = expectedOrigin;

  contents.setWindowOpenHandler(({ url }): WindowOpenHandlerResponse => {
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

  const onWillNavigate = (event: Electron.Event, url: string): void => {
    if (url === "about:blank") return;
    if (!isAllowedLoopbackUrl(url, activeOrigin)) {
      event.preventDefault();
    }
  };
  contents.on("will-navigate", onWillNavigate);

  return {
    setExpectedOrigin: origin => {
      activeOrigin = origin;
    },
    dispose: () => {
      contents.removeListener("will-navigate", onWillNavigate);
    },
  };
}
