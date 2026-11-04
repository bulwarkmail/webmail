"use client";

import { useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { withBasePath } from "@/lib/browser-navigation";
import { PopoutComposeApp } from "./popout-compose-app";
import { PopoutMessageApp } from "./popout-message-app";

/** The message id a pop-out address names. */
function messageIdOf(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const at = segments.lastIndexOf("message");
  return at >= 0 && segments[at + 1] ? decodeURIComponent(segments[at + 1]) : "";
}

/**
 * The desktop app's warm spare: a hidden window with the pop-out code loaded and
 * nothing signed in. When a pop-out is wanted the shell gives it an address. The
 * address bar changes without a load, which is where the pop-outs read their
 * arguments from, and the right one renders in a window that's already up.
 */
export function PopoutSpareApp() {
  const [target, setTarget] = useState<URL | null>(null);

  useEffect(() => {
    const spare = getDesktopBridge()?.windows?.spare;
    if (!spare) {
      // Someone typed the address, or a browser followed a link.
      window.location.replace(withBasePath("/"));
      return;
    }
    const stop = spare.onActivate((url) => {
      const next = new URL(url, window.location.href);
      window.history.replaceState(null, "", `${next.pathname}${next.search}`);
      setTarget(next);
      spare.taken();
    });
    spare.ready();
    return stop;
  }, []);

  if (!target) return <div data-popout-spare="" className="h-dvh bg-background" />;
  if (/\/popout\/compose\/?$/.test(target.pathname)) return <PopoutComposeApp />;
  return <PopoutMessageApp id={messageIdOf(target.pathname)} />;
}
