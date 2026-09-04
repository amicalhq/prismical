"use client";

import { AppLink as Link } from "./app-link";
import { usePathname } from "@prismical/app-client";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import type { SidebarNavItem } from "./sidebar-nav";
import { ShortcutHint } from "./shortcut-hint";

export function NavMain({ items }: { items: SidebarNavItem[] }) {
  const pathname = usePathname();
  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                asChild
                size="sm"
                className="text-sm text-sidebar-foreground"
                tooltip={item.title}
                isActive={pathname.startsWith(item.url)}
              >
                <Link href={item.url} aria-label={item.title}>
                  <item.icon /> <span>{item.title}</span>
                  {item.shortcut && <ShortcutHint shortcut={item.shortcut} />}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
