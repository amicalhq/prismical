"use client";

import * as React from "react";
import { usePathname, useDesktopCapabilities } from "@prismical/app-client";
import { AppSidebar } from "./app-sidebar";
import { DesktopChromeStrip } from "./desktop-chrome-strip";
import { SiteHeader } from "./site-header";
import { SidebarProvider, SidebarInset } from "../ui/sidebar";
import { CommandPaletteProvider, CommandPalette } from "./command-palette";
import { NavShortcuts } from "./nav-shortcuts";
import { CurrentNoteProvider } from "./current-note-context";
import { CurrentEditorProvider } from "./current-editor-context";
import { RecordingBottomCluster } from "../components/recording-bottom-cluster";

// The shared app shell. The web and desktop renderers mount
// the same sidebar + header + content + dock frame. The platform wrapper supplies
// the web-specific providers (single QueryClient, auth guard) ABOVE this.
//
// The bottom recording/Ask cluster is app-ui-internal (the whole closure — note
// editor + recording dock + Ask panel — lives in this package, and its
// browser concerns run through injected ports), so the shell mounts it directly.
// One platform slot remains:
//   • `accountSwitcher` — the sidebar-footer account/org switcher (platform auth
//                         actions live outside the sanitized AuthPort; web fills
//                         it, desktop main-owned).
//
// Mirrors the desktop `_app/route.tsx` shell: a single sidebar + inset, with the
// header, a centred scroll container for the page, and the recording cluster
// pinned to the bottom of the content area.
export function AppShell({
  children,
  accountSwitcher,
}: {
  children: React.ReactNode;
  accountSwitcher?: React.ReactNode;
}) {
  // Keying the page wrapper on the pathname re-mounts (and re-animates) it on a
  // real route change, but NOT on same-route query changes (folder/tag/sort on
  // /notes) — so filtering doesn't re-fade the whole page.
  const pathname = usePathname();
  // Keyboard shortcuts are a desktop-only feature: the browser
  // reserves/overrides most combos. On web we gate off the ⌘/Ctrl+B sidebar
  // toggle (below); ⌘K (command palette) stays, and the ⌘H/⌘, nav shortcuts
  // (NavShortcuts, left mounted) fire where the platform allows — just without
  // a sidebar chip. Desktop reports every capability, so it keeps ⌘/Ctrl+B too.
  const shortcutsSupported = useDesktopCapabilities().has("global-shortcuts");
  return (
    <CommandPaletteProvider>
      <CurrentNoteProvider>
      <CurrentEditorProvider>
      {/* Standard shadcn "inset" sidebar layout: the provider owns the flex
          shell, capped to the viewport (h-svh) so the inset panel sizes
          correctly and the content area scrolls internally — header and the
          recording dock stay put. */}
      <SidebarProvider
        enableKeyboardShortcut={shortcutsSupported}
        className="h-svh overflow-hidden"
        style={
          {
            "--header-height": "calc(var(--spacing) * 12)",
          } as React.CSSProperties
        }
      >
        {/* useSearchParams() in the sidebar + notes page needs a Suspense
            boundary so statically-prerendered routes don't bail out. */}
        <React.Suspense fallback={null}>
          <AppSidebar variant="inset" accountSwitcher={accountSwitcher} />
          {/* overflow-hidden clips children to the inset's rounded-xl corners
              so the header doesn't paint over them. */}
          <SidebarInset className="overflow-hidden">
            <SiteHeader />
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className="flex-1 overflow-y-auto">
                <div
                  className="mx-auto flex w-full flex-col gap-4 pt-6 md:gap-6"
                  style={{
                    maxWidth: "var(--content-max-width)",
                    paddingInline: "var(--content-padding)",
                    // Not py-6: the dock floats over this area, so the bottom
                    // gap has to clear it (see --dock-clearance).
                    paddingBottom: "var(--dock-clearance)",
                  }}
                >
                  {/* Subtle per-route fade/rise; skipped under reduced motion. */}
                  <div
                    key={pathname}
                    className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200 motion-safe:ease-out"
                  >
                    {children}
                  </div>
                </div>
              </div>
              <RecordingBottomCluster />
            </div>
          </SidebarInset>
          {/* LAST in the shell on purpose: Chromium resolves overlapping
              app-region rects by DOM paint order (last wins, z-blind), so the
              strip's no-drag toggle must paint after every other drag rect. */}
          <DesktopChromeStrip />
          <NavShortcuts />
        </React.Suspense>
        <CommandPalette />
      </SidebarProvider>
      </CurrentEditorProvider>
      </CurrentNoteProvider>
    </CommandPaletteProvider>
  );
}
