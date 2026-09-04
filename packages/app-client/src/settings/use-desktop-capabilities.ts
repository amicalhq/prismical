"use client";

// useDesktopCapabilities — the renderer seam onto the
// DesktopCapabilityPort's native action surface (update check, logs export, app
// reset, permission read/prompt/deep-link). The native settings controls gate
// themselves off `has(capability)` and call the action methods directly; there
// is no reactive state here (permission status is fetched imperatively), so this
// just hands back the port with a stable identity — reactive device settings
// still flow through the sibling useDeviceSettings hook.

import { usePorts } from "../ports-context";
import type { DesktopCapabilityPort } from "@prismical/app-contracts";

export function useDesktopCapabilities(): DesktopCapabilityPort {
  return usePorts().desktopCapabilities;
}
