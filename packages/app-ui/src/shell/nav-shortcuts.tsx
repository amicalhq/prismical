"use client";

import { useNavigation, useDesktopCapabilities } from "@prismical/app-client";
import { useShortcut } from "../lib/shortcuts";

/**
 * Global navigation shortcuts the sidebar has always advertised (the "⌘ H" /
 * "⌘ ," hints in sidebar-nav.ts) but nothing ever bound: ⌘/Ctrl+H → Home,
 * ⌘/Ctrl+, → Settings. Both combos come from the shortcuts registry
 * (lib/shortcuts.ts), which also feeds the sidebar hints and the settings
 * screen.
 *
 * Both entries are `desktopOnly`, and this is where that's enforced: web
 * mounts this component too, but binding there would preventDefault() Ctrl+H
 * (browser history) and Ctrl+, while the sidebar deliberately shows no chip for
 * them. The desktop app owns its keys, with its app menu moving
 * macOS Hide off ⌘H so the page actually receives it.
 */
export function NavShortcuts() {
  const router = useNavigation();
  const enabled = useDesktopCapabilities().has("global-shortcuts");

  useShortcut("go-home", () => router.push("/home"), { enabled });
  useShortcut("go-settings", () => router.push("/settings/preferences"), {
    enabled,
  });

  return null;
}
