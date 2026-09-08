import type { RecordingLaneFailure } from './service';

/** Native recovery retains audio, so it can wait up to its existing 30-minute backoff cap. */
export const recordingRetryAfterMs = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 250
    ? Math.min(Math.ceil(value), 30 * 60_000)
    : undefined;

/** These failures require account/configuration changes or a new recording. */
export const isSessionTranscriptionFailure = (failure: RecordingLaneFailure): boolean =>
  failure.kind === 'http' &&
  [
    'PROVIDER_KEY_INVALID',
    'PROVIDER_KEY_MISSING',
    'PROVIDER_QUOTA_EXCEEDED',
    'PROVIDER_MODEL_NOT_FOUND',
    'TRANSCRIPTION_MODEL_UNAVAILABLE',
    'TRANSCRIPTION_QUOTA_EXCEEDED',
    'RECORDING_LENGTH_EXCEEDED',
  ].includes(failure.code ?? '');
