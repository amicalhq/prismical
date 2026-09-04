"use client";

import { useDesktopCapabilities } from "@prismical/app-client";
import { cn } from "../lib/utils";
import { SidebarTrigger } from "../ui/sidebar";

/**
 * Desktop-only frameless chrome: a full-width drag
 * strip pinned over the window's top 40px carrying the sidebar toggle on the
 * traffic-light row — beside the lights on mac, at the window edge on Windows.
 * Viewport-fixed (not inside the sidebar) so the toggle stays put when the
 * offcanvas sidebar slides away. Web renders null.
 */
export function DesktopChromeStrip() {
  const caps = useDesktopCapabilities();
  const mac = caps.has("window-chrome-mac");
  const win = caps.has("window-chrome-windows");
  if (!mac && !win) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 h-10 [-webkit-app-region:drag]">
      <SidebarTrigger
        className={cn(
          "absolute top-2.5 [-webkit-app-region:no-drag]",
          mac ? "left-24" : "left-4",
        )}
      />
    </div>
  );
}
