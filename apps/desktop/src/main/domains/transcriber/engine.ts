/**
 * Engine resolution — the pure decision that turns the
 * stored preference (DeviceSettings.transcription) + the boot-resolved app
 * mode into the EFFECTIVE engine a recording runs under, plus the
 * transcriptionConfig frozen into the recording row for that engine.
 *
 * Resolved ONCE per recording at start (RecordingServiceLive) — a preference
 * change never re-routes a recording mid-flight. The recovery drain resolves
 * per row: the outbox row remembers the engine kind that produced it. On-device
 * audio must never follow a later switch to the cloud
 * engine), while model/BYOK details come from current settings (documented
 * in recovery-drain.ts).
 */
import type { TranscriptionEngine, TranscriptionSetting } from '@prismical/desktop-contracts';
import type { AppMode } from '../app-mode/service';
import { RECOMMENDED_MODEL_ID } from '../models/catalogue';
import { MANAGED_TRANSCRIPTION_CONFIG } from '../transport/live';

/** The frozen per-recording engine: what the lanes need to run a chunk. */
export interface RecordingEngine {
  readonly engine: TranscriptionEngine;
  /** Local whisper catalogue id — the preference, or the recommended default. */
  readonly modelId: string;
  readonly byokBaseUrl: string | null;
  readonly byokModel: string | null;
}

/**
 * Local mode has no cloud transcriber, so a stored 'cloud' preference (the
 * default) coerces to 'local' there; every other combination is the stored
 * choice verbatim (cloud mode may run local whisper or BYOK — axis B is
 * orthogonal to axis A). Model presence is NOT consulted here: the local lane
 * acks empty (once-warned) when its model is missing, so the recording row
 * still persists — never park a recording over a missing model.
 */
export const resolveRecordingEngine = (
  mode: AppMode,
  setting: TranscriptionSetting
): RecordingEngine => ({
  engine: mode === 'local' && setting.engine === 'cloud' ? 'local' : setting.engine,
  modelId: setting.modelId ?? RECOMMENDED_MODEL_ID,
  byokBaseUrl: setting.byokBaseUrl,
  byokModel: setting.byokModel,
});

/**
 * transcriptionConfig for an on-device whisper recording. Informational for
 * core (it reads only language/instanceId/modelId) and synced verbatim to
 * every client — NEVER carries `instanceId`: any value but the cloud
 * sentinel makes core resolve BYOK on a chunk upload and the finalize drain
 * treat the recording as BYOK-pinned. Kept apart from
 * MANAGED_TRANSCRIPTION_CONFIG on purpose: naming a whisper model here is
 * fine (the user downloaded and picked it), naming one there is a leak
 * (tests/policy/model-disclosure.test.ts).
 *
 * `model` carries a `local:` prefix rather than the bare catalogue id. This
 * keeps the user's on-device selection in a distinct namespace so it survives
 * sync redaction verbatim.
 */
export const LOCAL_WHISPER_TRANSCRIPTION_CONFIG = (modelId: string) =>
  ({ provider: 'local-whisper', model: `local:${modelId}`, language: 'en' }) as const;

/** transcriptionConfig for a desktop-BYOK recording (the key never leaves main). */
export const BYOK_DESKTOP_TRANSCRIPTION_CONFIG = (byokModel: string | null) =>
  ({ provider: 'byok-desktop', model: byokModel ?? 'unknown', language: 'en' }) as const;

/** The config frozen into BOTH the cloud create body and the product-store row. */
export const transcriptionConfigFor = (engine: RecordingEngine): Record<string, unknown> => {
  switch (engine.engine) {
    case 'cloud':
      return MANAGED_TRANSCRIPTION_CONFIG;
    case 'local':
      return LOCAL_WHISPER_TRANSCRIPTION_CONFIG(engine.modelId);
    case 'byok':
      return BYOK_DESKTOP_TRANSCRIPTION_CONFIG(engine.byokModel);
  }
};
