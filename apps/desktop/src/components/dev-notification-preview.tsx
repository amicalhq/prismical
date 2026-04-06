import { IconBellRinging } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { api } from "@/trpc/react";

export function DevNotificationPreview() {
  const openPreviewWindowMutation =
    api.notifications.showTestNotification.useMutation({
      onError: (error) => {
        toast.error("Failed to show test notification", {
          description: error.message,
        });
      },
    });

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => openPreviewWindowMutation.mutate()}
        disabled={openPreviewWindowMutation.isPending}
      >
        {openPreviewWindowMutation.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <IconBellRinging />
        )}
        <span>Test Notification</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
