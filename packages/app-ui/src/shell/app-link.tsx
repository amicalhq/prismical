"use client";

// AppLink — the platform link component.
//
// Renders whatever link the active NavigationPort supplies: on web that is
// next/link (prefetch behavior preserved); on desktop the TanStack router
// link. Call sites migrated off `next/link` render this instead, so the
// same JSX drives both renderers. Props are AppLinkComponentProps — the
// framework-free AppLinkProps (href, replace?) plus standard anchor props — and
// the ref is forwarded to the underlying <a> so Radix `asChild` slots (Button,
// SidebarMenuButton, DropdownMenuItem …) keep working.
//
// Lives with the ports context and the platform adapters in
// @prismical/app-ui as a unit.

import * as React from "react";
import { usePorts, type AppLinkComponentProps } from "@prismical/app-client";

// Optional navigation boundary; ordinary links outside it keep their original handlers.
export const LinkNavigationContext = React.createContext<(() => void) | null>(null);

export const AppLink = React.forwardRef<HTMLAnchorElement, AppLinkComponentProps>(
  function AppLink(props, ref) {
    const Link = usePorts().navigation.Link;
    const dismissSidebar = React.useContext(LinkNavigationContext);
    const onClick: React.MouseEventHandler<HTMLAnchorElement> = event => {
      props.onClick?.(event);
      const anchor = event.currentTarget;
      // Ignore cancelled clicks, downloads, external destinations and new tabs.
      // Run before the router handles this click so selecting the current route
      // also dismisses the drawer, even when no route update will be emitted.
      if (
        !event.defaultPrevented && event.button === 0 &&
        !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey &&
        (!anchor.target || anchor.target === "_self") &&
        !anchor.hasAttribute("download") &&
        anchor.protocol === window.location.protocol && anchor.host === window.location.host
      ) {
        dismissSidebar?.();
      }
    };
    return <Link ref={ref} {...props} onClick={dismissSidebar ? onClick : props.onClick} />;
  },
);
