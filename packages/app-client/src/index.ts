// @prismical/app-client barrel. The shared renderer data
// layer: apiClient + adapters, the query hooks, auth session seam, Ask/collab
// transports, recording pipeline, the ports context + injection runtime. The
// web shell re-exports these at their former `@/lib/...` paths (unchanged call
// sites); the shared UI shell and desktop mount import from here.

// Build-time canary for source-consumed package imports.
export const APP_CLIENT_CANARY = "app-client" as const;

// Injection runtime + the ports React context.
export * from "./runtime";
export * from "./ports-context";
export * from "./analytics-events";
export * from "./event-time";
export * from "./tags/tag-colors";

// api layer
export * from "./api/client";
export * from "./api/auth";
export * from "./api/adapters";
export * from "./api/transcription";
export * from "./api/query-client";

// query hooks
export * from "./api/hooks/account";
export * from "./api/hooks/api-keys";
export * from "./api/hooks/ask-conversation";
export * from "./api/hooks/automations";
export * from "./api/hooks/billing";
export * from "./api/hooks/connections";
export * from "./api/hooks/events";
export * from "./api/hooks/folders";
export * from "./api/hooks/instances";
export * from "./api/hooks/mcp-servers";
export * from "./api/hooks/model-defaults";
export * from "./api/hooks/note-tags";
export * from "./api/hooks/notes";
export * from "./api/hooks/organizations";
export * from "./api/hooks/people";
export * from "./api/hooks/profile";
export * from "./api/hooks/search";
export * from "./api/hooks/sharing";
export * from "./api/hooks/skill-runs";
export * from "./api/hooks/skills";
export * from "./api/hooks/tags";
export * from "./api/hooks/transcripts";
export * from "./api/hooks/vocabulary";

// ask
export * from "./ask/conversation";
export * from "./ask/mention";
export * from "./ask/models";
export * from "./ask/scope";
export * from "./ask/transport";

// notes (collab, stores, diff, editor)
export * from "./notes/artifact-inline-node-commands";
export * from "./notes/artifact-node-commands";
export * from "./notes/auto-enhance-store";
export * from "./notes/ask-skill-run-store";
export * from "./notes/diff/build-decorations";
export * from "./notes/diff/diff-plugin";
export * from "./notes/diff/selection-anchors";
export * from "./notes/diff/skill-diff-editor-lock";
export * from "./notes/diff/skill-diff-store";
export * from "./notes/diff/use-skill-diff-decorations";
export * from "./notes/editor-extensions";
export * from "./notes/inline-run-store";
export * from "./notes/skill-run-activity-store";
export * from "./notes/skill-run-retry";
export * from "./notes/use-note-collab";
export * from "./notes/use-open-note-for-event";
export * from "./notes/use-run-skill";

// recording
export * from "./recording/auto-enhance-setting";
export * from "./recording/chunker";
export * from "./recording/recording-preferences";
export * from "./recording/use-recording";
export * from "./recording/wav-encode";

// settings: device-local preferences seam and native action surface
export * from "./settings/use-device-settings";
export * from "./settings/use-desktop-capabilities";

// Sync layer (desktop injects the persistence factory; the provider is
// mounted inside ApiQueryProvider — shells don't mount it themselves).
export { createIndexedDbPersistPlugin } from "./sync/store";
export type { SyncPartition } from "./sync/partition";
export { useSyncStore } from "./sync/provider";

export { setTitleDraftDirty } from "./notes/title-drafts";
export * from "./errors/ai-user-error";
