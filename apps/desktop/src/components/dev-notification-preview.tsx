import { IconBellRinging } from "@tabler/icons-react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { api } from "@/trpc/react";

export function DevNotificationPreview() {
  const showTestDetectionMutation =
    api.meetingWidget.showTestDetection.useMutation({
      onError: (error) => {
        toast.error("Failed to show test detection", {
          description: error.message,
        });
      },
    });

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => showTestDetectionMutation.mutate()}
        disabled={showTestDetectionMutation.isPending}
      >
        {showTestDetectionMutation.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <IconBellRinging />
        )}
        <span>Test Detection</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
