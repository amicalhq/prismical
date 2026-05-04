/**
 * Pipeline module exports
 */

// Core types
export type {
  TranscriptionProvider,
  StreamingPipelineContext,
  StreamingSession,
} from "./core/pipeline-types";

// Context management
export { createDefaultContext } from "./core/context";
export type { PipelineContext, SharedPipelineData } from "./core/context";

// Main service
export { TranscriptionService } from "../services/transcription-service";

// Providers (if needed externally)
export { WhisperProvider } from "./providers/transcription/whisper-provider";
