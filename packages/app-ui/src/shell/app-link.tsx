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

export const AppLink = React.forwardRef<HTMLAnchorElement, AppLinkComponentProps>(
  function AppLink(props, ref) {
    const Link = usePorts().navigation.Link;
    return <Link ref={ref} {...props} />;
  },
);
