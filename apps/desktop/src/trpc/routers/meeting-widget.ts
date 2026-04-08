import { observable } from "@trpc/server/observable";
import { createRouter, procedure } from "../trpc";
import type { MeetingWidgetState } from "@/types/meeting-widget";

export const meetingWidgetRouter = createRouter({
  getState: procedure.query(({ ctx }) => {
    const meetingRecordingWidgetManager = ctx.serviceManager.getService(
      "meetingRecordingWidgetManager",
    );
    return meetingRecordingWidgetManager.getState();
  }),

  // eslint-disable-next-line deprecation/deprecation
  stateUpdates: procedure.subscription(({ ctx }) => {
    return observable<MeetingWidgetState>((emit) => {
      const meetingRecordingWidgetManager = ctx.serviceManager.getService(
        "meetingRecordingWidgetManager",
      );

      const handleStateChange = (state: MeetingWidgetState) => {
        emit.next(state);
      };

      emit.next(meetingRecordingWidgetManager.getState());
      meetingRecordingWidgetManager.on("state-changed", handleStateChange);

      return () => {
        meetingRecordingWidgetManager.off("state-changed", handleStateChange);
      };
    });
  }),
});
