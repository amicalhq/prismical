import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { SettingsSidebar } from "../../components/settings-sidebar";
import { SiteHeader } from "@/components/site-header";
import { MeetingRecordingBanner } from "../../components/meeting-recording-banner";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  SettingsHeaderProvider,
  useSettingsHeaderActions,
} from "./header-actions-context";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <SettingsHeaderProvider>
      <SettingsLayoutContent />
    </SettingsHeaderProvider>
  );
}

function SettingsLayoutContent() {
  const location = useLocation();
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const {
    actions: headerActions,
    headerContent,
    setHeaderContent,
  } = useSettingsHeaderActions();
  const [isScrolled, setIsScrolled] = useState(false);
  const isNoteDetailRoute = location.pathname.startsWith("/settings/notes/");

  // Keyboard shortcut: Cmd+H (Mac) / Ctrl+H (Windows/Linux) to navigate home
  const goHome = useCallback(() => {
    navigate({ to: "/settings/home" });
  }, [navigate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "h" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        goHome();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [goHome]);

  // Reset scroll state (and stale header content) on page change
  useEffect(() => {
    setIsScrolled(false);
    if (!isNoteDetailRoute) {
      setHeaderContent(null);
    }
  }, [isNoteDetailRoute, location.pathname, setHeaderContent]);

  // IntersectionObserver to detect title scrolling out of view
  useEffect(() => {
    if (isNoteDetailRoute) {
      return;
    }

    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsScrolled(!entry.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isNoteDetailRoute, location.pathname]);

  const getSettingsPageTitle = (pathname: string): string => {
    if (pathname.startsWith("/settings/home")) {
      return "Home";
    }

    if (pathname.startsWith("/settings/events")) {
      return "Events";
    }

    // Check for dynamic routes first
    if (pathname.startsWith("/settings/notes")) {
      return "Notes";
    }

    const routes: Record<string, string> = {
      "/settings/preferences": "Preferences",
      "/settings/dictation": "Dictation",
      "/settings/vocabulary": "Vocabulary",
      "/settings/shortcuts": "Shortcuts",
      "/settings/ai-models": "AI Models",
      "/settings/advanced": "Advanced",
      "/settings/about": "About",
    };
    return routes[pathname] || "Settings";
  };

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 64)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <div className="flex h-screen w-screen">
        <SettingsSidebar variant="inset" />
        <SidebarInset className="!mt-0">
          <SiteHeader
            currentView={
              headerContent ?? getSettingsPageTitle(location.pathname)
            }
            showTitle={isScrolled || headerContent != null}
            actions={headerActions ?? undefined}
          />
          <MeetingRecordingBanner />
          <div className="flex flex-1 flex-col min-h-0">
            <div className="@container/settings flex flex-1 flex-col min-h-0 overflow-hidden">
              <div
                ref={scrollRef}
                className={cn(
                  "flex-1",
                  isNoteDetailRoute ? "overflow-hidden" : "overflow-y-auto",
                )}
              >
                <div
                  className={cn(
                    "relative w-full",
                    isNoteDetailRoute
                      ? "flex h-full min-h-0 flex-col"
                      : "mx-auto flex flex-col gap-4 md:gap-6",
                  )}
                  style={
                    isNoteDetailRoute
                      ? {
                          paddingInline: "0px",
                        }
                      : {
                          maxWidth: "var(--content-max-width)",
                          paddingInline: "var(--content-padding)",
                        }
                  }
                >
                  <div
                    ref={sentinelRef}
                    className="absolute top-0 h-[60px] w-px"
                  />
                  <Outlet />
                </div>
              </div>
            </div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
