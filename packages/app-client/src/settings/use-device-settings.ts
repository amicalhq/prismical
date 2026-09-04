"use client";

// useDeviceSettings — the shared renderer seam onto the
// DesktopCapabilityPort's device-settings surface. The native settings screens
// read the live DeviceSettings, flip one preference at a time, and gate
// desktop-only controls off `has(capability)` — never a raw isDesktop branch.
// One general hook lets the launch-at-login, dock, language, and update controls reuse it.

import * as React from "react";
import {
  DEFAULT_DEVICE_SETTINGS,
  type DesktopCapability,
  type DeviceSettings,
} from "@prismical/app-contracts";
import { usePorts } from "../ports-context";

export interface UseDeviceSettings {
  /** The live device settings. Desktop: main's current values; web: the inert
   *  defaults (subscribe never emits there). */
  readonly settings: DeviceSettings;
  /** Merge a partial patch (fire-and-forget; the change flows back through the
   *  subscription). A no-op on web. */
  readonly set: (patch: Partial<DeviceSettings>) => Promise<void>;
  /** Whether a named desktop capability is present — gate desktop-only controls
   *  on this (false on web). */
  readonly has: (capability: DesktopCapability) => boolean;
}

export function useDeviceSettings(): UseDeviceSettings {
  const { desktopCapabilities } = usePorts();
  const [settings, setSettings] = React.useState<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);

  // subscribe replays the platform's latest settings immediately (desktop: main's
  // current DeviceSettings via the preload buffer; web: never emits, so the value
  // stays at the inert defaults) and returns its own unsubscribe.
  React.useEffect(
    () => desktopCapabilities.settings.subscribe(setSettings),
    [desktopCapabilities],
  );

  const set = React.useCallback(
    (patch: Partial<DeviceSettings>) => desktopCapabilities.settings.set(patch),
    [desktopCapabilities],
  );
  const has = React.useCallback(
    (capability: DesktopCapability) => desktopCapabilities.has(capability),
    [desktopCapabilities],
  );

  return { settings, set, has };
}
