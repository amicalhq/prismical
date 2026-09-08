import { sourceFrame } from '@desktop/logging/wire';
import { AI_ERROR_CODES, SKILL_RUN_ERROR_CODES } from '@prismical/api-contracts';
export { sanitizeSourceLocation as sanitizeTelemetrySourceLocation } from '@desktop/logging/wire';

type TelemetryValue = string | number | boolean | null;

// Only metadata used by the product event catalog or diagnostic boundaries.
// User-authored skill_name is deliberately excluded; skill_id still identifies it.
const ID_KEYS = new Set([
  'note_id',
  'recording_id',
  'resource_id',
  'conversation_id',
  'skill_id',
  'attempt_id',
  'execution_id',
  'request_id',
]);
const BOOLEAN_KEYS = new Set([
  'from_folder',
  'from_event',
  'automatic',
  'has_context',
  'scoped_to_recording',
  'replay',
  'app_is_packaged',
  '$process_person_profile',
]);
const NUMBER_KEYS = new Set([
  'segments',
  'grace_ms',
  'duration_ms',
  'attempt',
  'chunk_index',
  'client_at_ms',
  'elapsed_ms',
  'execution_duration_ms',
  'queued_ms',
  'preparing_ms',
  'request_ms',
  'transcript_wait_ms',
  'staging_ms',
  'request_count',
  'persistence_ready_ms',
  'notes_loaded_ms',
  'notes_failed_ms',
  'folders_loaded_ms',
  'folders_failed_ms',
  'tags_loaded_ms',
  'tags_failed_ms',
  'note_tags_loaded_ms',
  'note_tags_failed_ms',
  'create_gate_released_ms',
  'token_requested_ms',
  'token_resolved_ms',
  'socket_connected_ms',
  'authenticated_ms',
  'document_synced_ms',
  'local_log_hydrated_ms',
  'tour_version',
]);
const ENUMS: Record<string, readonly string[]> = {
  kind: ['sync_bootstrap', 'note_collaboration'],
  status: [
    'started',
    'pending_at_five_seconds',
    'ready',
    'published',
    'error',
    'abandoned',
    'superseded',
    'stopped',
    'skipped',
    'applied',
    'staged',
  ],
  phase: ['preparing', 'request', 'waiting-transcript', 'staging'],
  tour: ['first_note'],
  step: ['create', 'record', 'speak', 'stop', 'transcript', 'enhance', 'result', 'review'],
  action: ['created', 'recording', 'ready-to-stop', 'recorded', 'review', 'kept', 'continue'],
  code: [
    'create_failed',
    'recording_failed',
    'enhance_failed',
    'accept_failed',
    'target_unavailable',
    'tour_load_failed',
  ],
  source: [
    'chip',
    'composer',
    'wand',
    'auto-enhance',
    'inline',
    'refine',
    'dock',
    'main',
    'renderer',
    'worker',
    'native',
    'main_process',
    'renderer_process',
    'native_helper',
    'main-process',
    'preload',
    'renderer-process',
    'child-process',
    'boot',
    'runtime',
    'window-load',
  ],
  mode: [
    'append-section',
    'replace-doc',
    'inline-rewrite',
    'cloud',
    'local',
    'mic',
    'system',
    'dual',
  ],
  output_target: ['note-title', 'note-body'],
  resource_type: ['note', 'folder'],
  method: ['organization_member', 'email_invitation', 'public_link'],
  role: ['owner', 'admin', 'editor', 'viewer'],
  via: ['button', 'dismiss'],
  suggestion_source: ['starter', 'followup'],
  platform: ['macos', 'windows', 'linux', 'darwin', 'win32'],
  arch: ['arm64', 'x64', 'ia32', 'arm'],
  runtime: ['main', 'renderer', 'worker', 'native'],
  stage: [
    'module_load',
    'app_initialize',
    'runtime_boot',
    'uncaught_exception',
    'unhandled_rejection',
    'preload',
    'renderer_load',
    'renderer_crash',
    'child_process',
    'main-process',
    'renderer',
    'renderer-process',
    'child-process',
    'boot',
    'runtime',
    'window-load',
  ],
  error_context: [
    'uncaught_exception',
    'unhandled_rejection',
    'react_error_boundary',
    'preload',
    'renderer_load',
    'renderer_crash',
    'child_process',
    'startup',
    'main-process',
    'renderer',
    'renderer-process',
    'child-process',
    'boot',
    'runtime',
    'window-load',
  ],
  window_type: ['main', 'widget', 'notify', 'float-note'],
  route: ['main', 'settings', 'note', 'unknown'],
  process_type: [
    'Utility',
    'Zygote',
    'Sandbox helper',
    'GPU',
    'Pepper Plugin',
    'Pepper Plugin Broker',
    'Unknown',
  ],
};
const REASONS = [
  'spawn-failed',
  'worker-crashed',
  'timeout',
  'inference-failed',
  'model-missing',
  'storage-unavailable',
  'mic-denied',
  'permission-denied',
  'disconnected',
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
];
const CODES = [
  'ENOENT',
  'EACCES',
  'EPERM',
  'EPIPE',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOSPC',
  'SQLITE_BUSY',
  'SQLITE_CORRUPT',
];
const PRODUCT_ERROR_CODES = [
  ...CODES,
  ...Object.values(AI_ERROR_CODES),
  ...Object.values(SKILL_RUN_ERROR_CODES),
  'EDITOR_UNAVAILABLE',
  'NETWORK_ERROR',
  'CLIENT_ERROR',
];
const PROPERTY_KEYS = [
  ...ID_KEYS,
  ...BOOLEAN_KEYS,
  ...NUMBER_KEYS,
  ...Object.keys(ENUMS),
  'model_id',
  'app_version',
  'os_release',
  'error_code',
  'reason',
  'exit_code',
];
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'SecurityError',
  'TimeoutError',
  'InvalidStateError',
  'BootError',
  'StaleSessionError',
  'WhisperEngineError',
  'ProductDbError',
  'SecureStoreError',
  'EventKitHelperError',
  'DetectorSpawnError',
  'DetectorCrashError',
  'DetectorExitError',
  'DbError',
  'EventKitSyncError',
  'AskStreamError',
  'StreamError',
  'AuthFlowError',
  'TokenExchangeError',
  'TokenVerificationError',
  'RefreshError',
  'RevokeError',
  'WebSessionHandoffError',
  'AuthStateError',
  'AiProviderError',
  'RecordingBusyError',
  'RecordingStartError',
  'WindowError',
  'PermissionError',
  'ModelError',
  'RecoveryWriteError',
  'RecoveryFileError',
  'CaptureSpawnError',
  'CaptureCrashError',
  'CaptureExitError',
  'CaptureProtocolError',
  'CollabError',
]);

function field(input: unknown, key: string): unknown {
  if (input === null || typeof input !== 'object') return undefined;
  try {
    return Reflect.get(input, key);
  } catch {
    return undefined;
  }
}

/** Unknown keys and compound values never enter the remote event payload. */
export function sanitizeTelemetryProperties(input: unknown): Record<string, TelemetryValue> {
  const result: Record<string, TelemetryValue> = {};
  for (const key of PROPERTY_KEYS) {
    const value = field(input, key);
    if (ID_KEYS.has(key)) {
      if (value === null || (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)))
        result[key] = value;
    } else if (BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') result[key] = value;
    } else if (NUMBER_KEYS.has(key)) {
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= Number.MAX_SAFE_INTEGER
      )
        result[key] = value;
    } else if (key === 'exit_code') {
      if (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        Math.abs(value) <= 2_147_483_648
      )
        result[key] = value;
    } else if (typeof value === 'string') {
      if (key === 'model_id' && /^[a-zA-Z0-9_.:-]{1,96}(?:\/[a-zA-Z0-9_.:-]{1,96})?$/.test(value))
        result[key] = value;
      else if (
        (key === 'app_version' || key === 'os_release') &&
        /^\d[\d.a-zA-Z_-]{0,63}$/.test(value)
      )
        result[key] = value;
      else if (key === 'error_code' && PRODUCT_ERROR_CODES.includes(value)) result[key] = value;
      else if (key === 'reason' && REASONS.includes(value)) result[key] = value;
      else if (ENUMS[key]?.includes(value)) result[key] = value;
    }
  }
  return result;
}

/** Preserve grouping and source frames without forwarding messages or bodies. */
export function sanitizeTelemetryError(input: unknown): Error {
  const tag = field(input, '_tag');
  const rawName = field(input, 'name');
  const name =
    typeof tag === 'string' && ERROR_NAMES.has(tag)
      ? tag
      : typeof rawName === 'string' && ERROR_NAMES.has(rawName)
        ? rawName
        : 'Error';
  const error = new Error(`${name} captured`);
  error.name = name;
  const code = field(input, 'code');
  const reason = field(input, 'reason');
  if (typeof code === 'string' && CODES.includes(code)) Object.assign(error, { code });
  if (typeof reason === 'string' && REASONS.includes(reason)) Object.assign(error, { reason });
  const rawStack = field(input, 'stack');
  const frames =
    typeof rawStack === 'string'
      ? rawStack
          .slice(0, 16_384)
          .split('\n')
          .slice(0, 80)
          .flatMap(line => {
            const frame = sourceFrame(line);
            return frame === undefined ? [] : [frame];
          })
          .slice(0, 20)
      : [];
  // Do not report this helper's own stack when the original had no safe frames.
  error.stack = [`${name}: ${error.message}`, ...frames].join('\n');
  return error;
}
