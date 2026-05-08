import { ErrorCodes, type ErrorCode } from "./error";

export type RecordingNotificationType =
  | "no_audio"
  | "empty_transcript"
  | "transcription_failed";

export type RecordingNotificationActionIcon = "discord";

export type I18nText = {
  key: string;
  params?: Record<string, string | number>;
};

export type LocalizedText = string | I18nText;

export interface RecordingNotificationAction {
  label: LocalizedText;
  icon?: RecordingNotificationActionIcon;
  navigateTo?: string; // Route to navigate to in main window
  externalUrl?: string; // External URL to open
}

export interface RecordingNotificationConfig {
  title: LocalizedText;
  description: LocalizedText;
  subDescription?: LocalizedText;
  primaryAction?: RecordingNotificationAction;
  secondaryAction?: RecordingNotificationAction;
}

export interface RecordingNotification {
  id: string;
  type: RecordingNotificationType;
  title: LocalizedText;
  description?: LocalizedText; // Pre-filled description, or generated via template on frontend
  subDescription?: LocalizedText;
  errorCode?: ErrorCode; // For transcription_failed
  traceId?: string; // For cloud debugging
  primaryAction?: RecordingNotificationAction;
  secondaryAction?: RecordingNotificationAction;
  timestamp: number;
}

// Fallback template function to generate description with mic name (used on frontend when description not provided)
export const getRecordingNotificationDescription = (
  type: RecordingNotificationType,
  microphoneName: string,
): I18nText => {
  switch (type) {
    case "no_audio":
      return {
        key: "recordingNotifications.notifications.description.noAudio",
        params: { microphone: microphoneName },
      };
    case "empty_transcript":
      return {
        key: "recordingNotifications.notifications.description.emptyTranscript",
        params: { microphone: microphoneName },
      };
    case "transcription_failed":
      return {
        key: "recordingNotifications.notifications.description.transcriptionFailed",
      };
  }
};

// Discord support server URL (same as sidebar Community link)
export const DISCORD_SUPPORT_URL = "https://prismical.ai/community";

// Config keyed directly by error code
export const RECORDING_NOTIFICATION_ERROR_CODE_CONFIG: Record<
  ErrorCode,
  RecordingNotificationConfig
> = {
  [ErrorCodes.AUTH_REQUIRED]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.authRequired.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.authRequired.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: { key: "recordingNotifications.notifications.action.logIn" },
      navigateTo: "/settings/ai-models",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  [ErrorCodes.RATE_LIMIT_EXCEEDED]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.rateLimitExceeded.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.rateLimitExceeded.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: { key: "recordingNotifications.notifications.action.viewUsage" },
      navigateTo: "/settings/ai-models",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  [ErrorCodes.INTERNAL_SERVER_ERROR]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.internalServerError.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.internalServerError.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
    secondaryAction: {
      label: {
        key: "recordingNotifications.notifications.action.viewHistory",
      },
      navigateTo: "/notes",
    },
  },
  [ErrorCodes.UNKNOWN]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.unknown.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.unknown.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: {
        key: "recordingNotifications.notifications.action.viewHistory",
      },
      navigateTo: "/notes",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  [ErrorCodes.NETWORK_ERROR]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.networkError.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.networkError.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: { key: "recordingNotifications.notifications.action.settings" },
      navigateTo: "/settings/preferences",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  [ErrorCodes.MODEL_MISSING]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.modelMissing.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.modelMissing.description",
    },
    primaryAction: {
      label: { key: "recordingNotifications.notifications.action.aiModels" },
      navigateTo: "/settings/ai-models",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  [ErrorCodes.WORKER_INITIALIZATION_FAILED]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.workerInitializationFailed.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.workerInitializationFailed.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  [ErrorCodes.WORKER_CRASHED]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.workerCrashed.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.workerCrashed.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  [ErrorCodes.LOCAL_TRANSCRIPTION_FAILED]: {
    title: {
      key: "recordingNotifications.notifications.errorCode.localTranscriptionFailed.title",
    },
    description: {
      key: "recordingNotifications.notifications.errorCode.localTranscriptionFailed.description",
    },
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: {
        key: "recordingNotifications.notifications.action.viewHistory",
      },
      navigateTo: "/notes",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
};

export const RECORDING_NOTIFICATION_CONFIG: Record<
  RecordingNotificationType,
  RecordingNotificationConfig
> = {
  no_audio: {
    title: {
      key: "recordingNotifications.notifications.type.noAudio.title",
    },
    description: {
      key: "recordingNotifications.notifications.type.noAudio.description",
    }, // Fallback, replaced by template
    primaryAction: {
      label: {
        key: "recordingNotifications.notifications.action.configureMicrophone",
      },
      navigateTo: "/settings/dictation",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  empty_transcript: {
    title: {
      key: "recordingNotifications.notifications.type.emptyTranscript.title",
    },
    description: {
      key: "recordingNotifications.notifications.type.emptyTranscript.description",
    }, // Fallback, replaced by template
    subDescription: {
      key: "recordingNotifications.notifications.recordingSaved",
    },
    primaryAction: {
      label: {
        key: "recordingNotifications.notifications.action.configureMicrophone",
      },
      navigateTo: "/settings/dictation",
    },
    secondaryAction: {
      label: { key: "recordingNotifications.notifications.action.support" },
      icon: "discord",
      externalUrl: DISCORD_SUPPORT_URL,
    },
  },
  // Placeholder for type checking; actual config comes from error-code mapping.
  transcription_failed:
    RECORDING_NOTIFICATION_ERROR_CODE_CONFIG[ErrorCodes.UNKNOWN],
};

export const RECORDING_NOTIFICATION_TIMEOUT = 5000;
