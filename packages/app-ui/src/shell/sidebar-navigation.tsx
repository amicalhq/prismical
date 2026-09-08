"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "@prismical/app-client";
import { useSidebar } from "../ui/sidebar";

import { LinkNavigationContext } from "./app-link";

/** Keep this boundary mounted outside the mobile sheet, which unmounts when closed. */
export function SidebarNavigation({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { setOpenMobile } = useSidebar();
  const dismiss = React.useCallback(() => setOpenMobile(false), [setOpenMobile]);

  // Covers history, imperative navigation, and query-only folder/tag selection.
  // Only the transient drawer changes; the desktop sidebar preference is untouched.
  React.useEffect(() => {
    dismiss();
  }, [pathname, search, dismiss]);

  return (
    <LinkNavigationContext.Provider value={dismiss}>
      {children}
    </LinkNavigationContext.Provider>
  );
}
