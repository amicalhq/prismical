// Product analytics event catalog. Shared data hooks name events here and
// capture them through the injected AnalyticsPort. The web
// shell re-exports these from its posthog module (call sites unchanged); the
// port implementation on each platform owns the actual transport.

export const EVENTS = {
  USER_SIGNED_IN: "user_signed_in",
  USER_SIGNED_OUT: "user_signed_out",
  ACCOUNT_DELETED: "account_deleted",
  NOTE_CREATED: "note_created",
  NOTE_DELETED: "note_deleted",
  RESOURCE_SHARED: "resource_shared",
  ONBOARDING_PROMPT_VIEWED: "onboarding_prompt_viewed",
  ONBOARDING_PROMPT_ACTIONED: "onboarding_prompt_actioned",
  RECORDING_STARTED: "recording_started",
  RECORDING_PAUSED: "recording_paused",
  RECORDING_RESUMED: "recording_resumed",
  // Auto-pause interaction events distinguish prompts, user overrides, and completed pauses.
  RECORDING_AUTO_PAUSE_PROMPTED: "recording_auto_pause_prompted",
  RECORDING_AUTO_PAUSE_KEPT: "recording_auto_pause_kept",
  RECORDING_AUTO_PAUSED: "recording_auto_paused",
  RECORDING_AUTO_STOPPED: "recording_auto_stopped",
  RECORDING_COMPLETED: "recording_completed",
  ASK_AI_MESSAGE_SENT: "ask_ai_message_sent",
  SKILL_RUN: "skill_run",
} as const;

export type AnalyticsEvent = (typeof EVENTS)[keyof typeof EVENTS];
