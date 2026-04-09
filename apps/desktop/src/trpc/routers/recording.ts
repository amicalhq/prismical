import { observable } from "@trpc/server/observable";
import { createRouter, procedure } from "../trpc";
import { v4 as uuid } from "uuid";
import type { RecordingState } from "../../types/recording";
import type { RecordingMode } from "../../main/managers/recording-manager";
import type {
  RecordingNotification,
  RecordingNotificationType,
  RecordingNotificationConfig,
} from "../../types/recording-notification";
import {
  RECORDING_NOTIFICATION_CONFIG,
  RECORDING_NOTIFICATION_ERROR_CODE_CONFIG,
} from "../../types/recording-notification";
import { ErrorCodes, type ErrorCode } from "../../types/error";

interface RecordingStateUpdate {
  state: RecordingState;
  mode: RecordingMode;
}

export const recordingRouter = createRouter({
  signalStart: procedure.mutation(async ({ ctx }) => {
    const recordingManager = ctx.serviceManager.getService("recordingManager");
    if (!recordingManager) {
      throw new Error("Recording manager not available");
    }
    return await recordingManager.signalStart();
  }),

  signalStop: procedure.mutation(async ({ ctx }) => {
    const recordingManager = ctx.serviceManager.getService("recordingManager");
    if (!recordingManager) {
      throw new Error("Recording manager not available");
    }
    return await recordingManager.signalStop();
  }),

  // Using Observable instead of async generator due to Symbol.asyncDispose conflict
  // Modern Node.js (20+) adds Symbol.asyncDispose to async generators natively,
  // which conflicts with electron-trpc's attempt to add the same symbol.
  // While Observables are deprecated in tRPC, they work without this conflict.
  // TODO: Remove this workaround when electron-trpc is updated to handle native Symbol.asyncDispose
  // eslint-disable-next-line deprecation/deprecation
  stateUpdates: procedure.subscription(({ ctx }) => {
    return observable<RecordingStateUpdate>((emit) => {
      const recordingManager =
        ctx.serviceManager.getService("recordingManager");
      if (!recordingManager) {
        throw new Error("Recording manager not available");
      }

      // Emit initial state
      emit.next({
        state: recordingManager.getState(),
        mode: recordingManager.getRecordingMode(),
      });

      // Set up listener for state changes
      const handleStateChange = (status: RecordingState) => {
        emit.next({
          state: status,
          mode: recordingManager.getRecordingMode(),
        });
      };

      const handleModeChange = (mode: RecordingMode) => {
        emit.next({
          state: recordingManager.getState(),
          mode,
        });
      };

      recordingManager.on("state-changed", handleStateChange);
      recordingManager.on("mode-changed", handleModeChange);

      // Cleanup function
      return () => {
        recordingManager.off("state-changed", handleStateChange);
        recordingManager.off("mode-changed", handleModeChange);
      };
    });
  }),

  // Recording notification subscription
  recordingNotifications: procedure.subscription(({ ctx }) => {
    return observable<RecordingNotification>((emit) => {
      const recordingManager =
        ctx.serviceManager.getService("recordingManager");
      if (!recordingManager) {
        throw new Error("Recording manager not available");
      }

      const handleNotification = (data: {
        type: RecordingNotificationType;
        errorCode?: ErrorCode;
        uiTitle?: string;
        uiMessage?: string;
        traceId?: string;
      }) => {
        let config: RecordingNotificationConfig;

        if (data.type === "transcription_failed" && data.errorCode) {
          config =
            RECORDING_NOTIFICATION_ERROR_CODE_CONFIG[data.errorCode] ??
            RECORDING_NOTIFICATION_ERROR_CODE_CONFIG[ErrorCodes.UNKNOWN];
        } else {
          config = RECORDING_NOTIFICATION_CONFIG[data.type];
        }

        emit.next({
          id: uuid(),
          type: data.type,
          // Use UI overrides if provided, fall back to config
          title: data.uiTitle ?? config.title,
          // Only send description for transcription_failed; audio notifications use mic-name template on frontend
          description:
            data.type === "transcription_failed"
              ? (data.uiMessage ?? config.description)
              : undefined,
          subDescription: config.subDescription,
          errorCode: data.errorCode,
          traceId: data.traceId,
          primaryAction: config.primaryAction,
          secondaryAction: config.secondaryAction,
          timestamp: Date.now(),
        });
      };

      recordingManager.on("recording-notification", handleNotification);

      // Cleanup function
      return () => {
        recordingManager.off("recording-notification", handleNotification);
      };
    });
  }),
});
