import { observable } from "@trpc/server/observable";
import type { MeetingStartNotificationState } from "@/types/meeting-start-notifications";
import { createRouter, procedure } from "../trpc";

export const notificationsRouter = createRouter({
  getState: procedure.query(({ ctx }) => {
    const meetingStartNotificationManager = ctx.serviceManager.getService(
      "meetingStartNotificationManager",
    );
    return meetingStartNotificationManager.getState();
  }),

  dismiss: procedure.mutation(async ({ ctx }) => {
    const meetingStartNotificationManager = ctx.serviceManager.getService(
      "meetingStartNotificationManager",
    );
    await meetingStartNotificationManager.dismissActiveNotification();
    return true;
  }),

  startNote: procedure.mutation(async ({ ctx }) => {
    const meetingStartNotificationManager = ctx.serviceManager.getService(
      "meetingStartNotificationManager",
    );
    return await meetingStartNotificationManager.startNoteFromNotification();
  }),

  showTestNotification: procedure.mutation(async ({ ctx }) => {
    const meetingStartNotificationManager = ctx.serviceManager.getService(
      "meetingStartNotificationManager",
    );
    await meetingStartNotificationManager.showTestNotification();
    return true;
  }),

  // eslint-disable-next-line deprecation/deprecation
  stateUpdates: procedure.subscription(({ ctx }) => {
    return observable<MeetingStartNotificationState>((emit) => {
      const meetingStartNotificationManager = ctx.serviceManager.getService(
        "meetingStartNotificationManager",
      );

      const handleStateChange = () => {
        emit.next(meetingStartNotificationManager.getState());
      };

      emit.next(meetingStartNotificationManager.getState());
      meetingStartNotificationManager.on("state-changed", handleStateChange);

      return () => {
        meetingStartNotificationManager.off("state-changed", handleStateChange);
      };
    });
  }),
});
