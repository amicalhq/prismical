/**
 * ByokTranscriberLive — the bring-your-own-key lane: the
 * chunk goes to an OpenAI-compatible `POST {baseUrl}/audio/transcriptions`
 * (OpenAI, Groq, a self-hosted whisper server…) with the user's key, and the
 * device mints the segment from the answer's `text`. The multipart request
 * carries `model`, `file` (audio.wav), `language`, and `response_format=verbose_json`
 * for Whisper models.
 *
 * The endpoint-bound key lives ONLY in SecureStore (`transcription.byok.apiKey`); it is
 * stamped into Authorization and NEVER passed to a log call — the base URL is
 * not logged either (a self-hosted endpoint can carry a token in its path).
 * Logs carry booleans + status codes.
 *
 * Per chunk: key + base URL + model present (else `not-configured`,
 * retryable for missing credentials, ONE warn per recording) → the near-silence guard → 48 kHz →
 * 16 kHz → PCM16 WAV → the POST with a 30 s budget. A 429/5xx response or
 * network/timeout failure is retryable; other 4xx responses are
 * permanent (that chunk's text is lost, the recording continues). No `prompt`
 * multipart field — hint injection is provider-specific and not relied on —
 * but the deterministic replacement pass runs on-device using the workspace
 * vocabulary source.
 */
import { Clock, Duration, Effect, HashSet, Layer, Ref } from 'effect';
import { applyReplacements, filterWhisperTranscript } from '@prismical/ai-prompts/transcription';
import { MainLogger } from '../../infra/logging/service';
import { ProductDb } from '../../infra/product-db/service';
import { SecureStore } from '../../infra/secure-store/service';
import { AppModeService } from '../app-mode/service';
import { encodeWavPcm16 } from '../recording/wav';
import { isTransientStatus, type FetchLike } from '../transport/live';
import {
  WorkspaceBackend,
  type RecordingLaneFailure,
  type RecordingLaneResult,
  type RecordingSegment,
} from '../transport/service';
import { WHISPER_SAMPLE_RATE, isNearSilence, resampleChunkForWhisper } from './audio';
import { mintChunkSegment } from './segment';
import { ByokTranscriberLane, type TranscriberLaneApi } from './service';
import { makeVocabularySource } from './vocabulary';
import { BYOK_API_KEY_SECRET, byokKeyForEndpoint } from './byok-credential';

/** OpenAI-compatible transcription path, appended to the user's base URL (`…/v1`). */
export const BYOK_TRANSCRIPTIONS_PATH = '/audio/transcriptions';
/** Request deadline for one chunk and one provider call. */
export const BYOK_REQUEST_TIMEOUT = Duration.seconds(30);
/** The desktop constant (BYOK_DESKTOP_TRANSCRIPTION_CONFIG.language). */
const BYOK_LANGUAGE = 'en';

const EMPTY_OK: RecordingLaneResult<readonly RecordingSegment[]> = { ok: true, value: [] };
const NOT_CONFIGURED: RecordingLaneResult<readonly RecordingSegment[]> = {
  ok: false,
  retryable: false,
  failure: { kind: 'engine', reason: 'not-configured' },
};

type LaneAbort = Extract<RecordingLaneFailure, { kind: 'network' | 'timeout' }>;

export interface ByokTranscriberLiveOptions {
  /** Injected for tests; defaults to the ambient main-process fetch. */
  readonly fetchFn?: FetchLike;
}

export const makeByokTranscriberLive = (
  options: ByokTranscriberLiveOptions = {}
): Layer.Layer<
  ByokTranscriberLane,
  never,
  SecureStore | MainLogger | ProductDb | AppModeService | WorkspaceBackend
> =>
  Layer.effect(
    ByokTranscriberLane,
    Effect.gen(function* () {
      const secrets = yield* SecureStore;
      const product = yield* ProductDb;
      const appMode = yield* AppModeService;
      const backend = yield* WorkspaceBackend;
      const log = (yield* MainLogger).scoped('transcriber');
      const fetchFn: FetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));
      // The mode-aware term source for the on-device replacement pass.
      const source = makeVocabularySource({ mode: appMode.mode, product, backend, log });
      const warnedUnconfigured = yield* Ref.make(HashSet.empty<string>());

      const warnUnconfiguredOnce = (
        recordingId: string,
        data: Record<string, boolean>
      ): Effect.Effect<void> =>
        Ref.modify(warnedUnconfigured, seen => [
          HashSet.has(seen, recordingId),
          HashSet.add(seen, recordingId),
        ]).pipe(
          Effect.flatMap(seen =>
            seen
              ? Effect.void
              : log.warn('BYOK transcription credentials unavailable', { context: {
                  recordingId,
                  ...data,
                } })
          )
        );

      // A SecureStore failure (safeStorage unavailable / decrypt failed / DB)
      // reads as "no key" — the lane cannot transcribe without it either way.
      const readKey = (recordingId: string, baseUrl: string | null): Effect.Effect<string | null> =>
        secrets.getSecret(BYOK_API_KEY_SECRET).pipe(
          Effect.map(secret => byokKeyForEndpoint(secret, baseUrl)),
          Effect.catchAll(error =>
            log
              .warn('BYOK key unreadable', { context: { recordingId }, error: error._tag })
              .pipe(Effect.as(null))
          )
        );

      const transcribeChunk: TranscriberLaneApi['transcribeChunk'] = (
        recordingId,
        params,
        audio,
        engine
      ) =>
        Effect.gen(function* () {
          const key = yield* readKey(recordingId, engine.byokBaseUrl);
          const hasKey = key !== null && key !== '';
          const hasBaseUrl = engine.byokBaseUrl !== null && engine.byokBaseUrl !== '';
          const hasModel = engine.byokModel !== null && engine.byokModel !== '';
          if (!hasKey || !hasBaseUrl || !hasModel) {
            yield* warnUnconfiguredOnce(recordingId, { hasKey, hasBaseUrl, hasModel });
            return { ...NOT_CONFIGURED, retryable: hasBaseUrl && hasModel };
          }
          if (isNearSilence(audio.samples)) return EMPTY_OK;

          const wav = encodeWavPcm16(resampleChunkForWhisper(audio.samples), WHISPER_SAMPLE_RATE);
          const form = new FormData();
          form.append('model', engine.byokModel);
          form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
          form.append('language', BYOK_LANGUAGE);
          // Newer non-Whisper models may only support json responses.
          const isWhisper = engine.byokModel.toLowerCase().includes('whisper');
          form.append('response_format', isWhisper ? 'verbose_json' : 'json');
          if (isWhisper) form.append('temperature', '0');
          const url = `${engine.byokBaseUrl.trim().replace(/\/+$/, '')}${BYOK_TRANSCRIPTIONS_PATH}`;

          const outcome = yield* Effect.tryPromise({
            try: async (signal): Promise<RecordingLaneResult<string>> => {
              const response = await fetchFn(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}` },
                body: form,
                signal,
              });
              const bodyJson: unknown = await response.json().catch(() => null);
              if (response.ok) {
                const text = (bodyJson as { text?: unknown } | null)?.text;
                return typeof text === 'string'
                  ? { ok: true, value: isWhisper ? filterWhisperTranscript(text, bodyJson) : text }
                  : { ok: false, retryable: true, failure: { kind: 'invalid-response' } };
              }
              const code = (bodyJson as { error?: { code?: unknown } } | null)?.error?.code;
              return {
                ok: false,
                retryable: isTransientStatus(response.status),
                failure: {
                  kind: 'http',
                  status: response.status,
                  ...(typeof code === 'string' ? { code } : {}),
                },
              };
            },
            catch: (): LaneAbort => ({ kind: 'network' }),
          }).pipe(
            Effect.timeoutFail({
              duration: BYOK_REQUEST_TIMEOUT,
              onTimeout: (): LaneAbort => ({ kind: 'timeout' }),
            }),
            Effect.catchAll((abort: LaneAbort) =>
              Effect.succeed<RecordingLaneResult<string>>({
                ok: false,
                retryable: true,
                failure: abort,
              })
            ),
            Effect.catchAllDefect(() =>
              Effect.succeed<RecordingLaneResult<string>>({
                ok: false,
                retryable: true,
                failure: { kind: 'network' },
              })
            )
          );

          if (!outcome.ok) {
            yield* log.warn('BYOK transcription chunk failed', { context: {
              recordingId,
              chunkIndex: params.chunkIndex,
              source: params.source,
              failure: outcome.failure,
              retryable: outcome.retryable,
            } });
            return outcome;
          }
          // Run the deterministic replacement pass over the workspace's terms.
          const terms = yield* source.termsFor(recordingId);
          const replaced = applyReplacements(outcome.value, terms);
          const now = yield* Clock.currentTimeMillis;
          const segment = mintChunkSegment({
            recordingId,
            params,
            samples: audio.samples,
            text: replaced.text,
            now,
          });
          if (segment === null) return EMPTY_OK;
          if (replaced.hits.length > 0) {
            // Only count replacements after a segment was written. The cloud
            // source intentionally treats this as a no-op.
            yield* source.bumpUsage(recordingId, replaced.hits);
          }
          return { ok: true, value: [segment] } satisfies RecordingLaneResult<
            readonly RecordingSegment[]
          >;
        });

      const api: TranscriberLaneApi = { transcribeChunk };
      return api;
    })
  );

/** The default lane (ambient fetch). */
export const ByokTranscriberLive: Layer.Layer<
  ByokTranscriberLane,
  never,
  SecureStore | MainLogger | ProductDb | AppModeService | WorkspaceBackend
> = makeByokTranscriberLive();
