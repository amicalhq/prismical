/**
 * Boot-service stubs for tests that build workspace layers:
 * WorkspaceLayerEnv widened with SettingsService / SecureStore / AppModeService /
 * ModelManager / WhisperEngine (engine resolution + the lanes' deps), so every
 * harness that `Layer.build`s a workspace — or the RecordingService / drain
 * directly — needs inert stand-ins. Also the Transcriber stack the recording
 * harnesses mount over their fake WorkspaceBackend (cloud lane real, local/byok
 * lanes swappable — the placeholders by default), and a scriptable fake
 * WhisperEngine for the local lane's own tests.
 */
import { Effect, Layer, Option, SubscriptionRef } from 'effect';
import { testTelemetryLayer } from './telemetry';
import type { TelemetryService } from '../../src/main/domains/telemetry/service';
import {
  DEFAULT_DEVICE_SETTINGS,
  type DeviceSettings,
  type ModelsStateView,
} from '@prismical/desktop-contracts';
import { AppModeService, makeAppMode, type AppMode } from '../../src/main/domains/app-mode/service';
import { ModelManager, type ModelManagerApi } from '../../src/main/domains/models/service';
import { SettingsService, type SettingsServiceApi } from '../../src/main/domains/settings/service';
import { CloudTranscriberLive } from '../../src/main/domains/transcriber/cloud';
import { TranscriberLive } from '../../src/main/domains/transcriber/live';
import {
  ByokTranscriberPlaceholderLive,
  LocalTranscriberPlaceholderLive,
} from '../../src/main/domains/transcriber/placeholder';
import {
  ByokTranscriberLane,
  LocalTranscriberLane,
  type Transcriber,
} from '../../src/main/domains/transcriber/service';
import type { WorkspaceBackend } from '../../src/main/domains/transport/service';
import type { MainLogger } from '../../src/main/infra/logging/service';
import { SecureStore, type SecureStoreService } from '../../src/main/infra/secure-store/service';
import type { LanguageModel } from 'ai';
import type { AiProviderKind } from '@prismical/desktop-contracts';
import {
  AiProvider,
  AiProviderError,
  type AiProviderApi,
  type ToolSupport,
} from '../../src/main/domains/ai-provider/service';
import type {
  WhisperDecodeOptions,
  WorkerTranscription,
} from '../../src/main/infra/whisper/protocol';
import {
  WhisperEngine,
  WhisperEngineError,
  type WhisperEngineApi,
} from '../../src/main/infra/whisper/service';

export interface FakeSettings {
  readonly layer: Layer.Layer<SettingsService>;
  /** The live ref — flip a preference mid-test through SubscriptionRef.update. */
  readonly ref: Effect.Effect<SubscriptionRef.SubscriptionRef<DeviceSettings>>;
}

/**
 * A SettingsService over a plain SubscriptionRef (no KV, no decode): `set`
 * merges, `reset` restores the defaults. `overrides` seed the initial value.
 */
export const makeFakeSettings = (overrides: Partial<DeviceSettings> = {}): FakeSettings => {
  const initial: DeviceSettings = { ...DEFAULT_DEVICE_SETTINGS, ...overrides };
  let live: SubscriptionRef.SubscriptionRef<DeviceSettings> | undefined;
  const layer = Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(initial);
      live = ref;
      const api: SettingsServiceApi = {
        settings: ref,
        get: SubscriptionRef.get(ref),
        set: patch => SubscriptionRef.update(ref, current => ({ ...current, ...patch })),
        reset: SubscriptionRef.set(ref, DEFAULT_DEVICE_SETTINGS),
      };
      return api;
    })
  );
  return {
    layer,
    ref: Effect.sync(() => {
      if (live === undefined) throw new Error('fake settings layer not built yet');
      return live;
    }),
  };
};

/** An in-memory SecureStore (plaintext Map — tests only). */
/**
 * An AiProvider whose `resolve` fails not-configured unless a test hands it a
 * model (ai/test's MockLanguageModelV4 — the skill/ask lanes then run against
 * a scripted provider); `instances` lists that one synthetic row.
 */
export const fakeAiProviderLayer = (
  options: {
    readonly model?: LanguageModel;
    readonly provider?: AiProviderKind;
    readonly modelId?: string;
    readonly toolSupport?: ToolSupport;
  } = {}
): Layer.Layer<AiProvider> =>
  Layer.sync(AiProvider, () => {
    const provider = options.provider ?? 'openai';
    const modelId = options.modelId ?? 'fake-model';
    const instanceId = `inst_local_${provider}`;
    const memo = new Map<string, ToolSupport>();
    const api: AiProviderApi = {
      resolve: (selection = {}) =>
        options.model === undefined
          ? Effect.fail(new AiProviderError({ reason: 'not-configured', provider }))
          : Effect.succeed({
              provider,
              modelId: selection.modelId ?? modelId,
              instanceId,
              model: options.model,
              toolSupport:
                memo.get(`${provider}:${selection.modelId ?? modelId}`) ??
                options.toolSupport ??
                'unknown',
            }),
      listModels: () => Effect.succeed({ models: [modelId], error: null }),
      forget: () => Effect.sync(() => memo.clear()),
      instances: Effect.succeed(
        options.model === undefined
          ? []
          : [{ instanceId, provider, label: 'Fake', models: [modelId] }]
      ),
      defaultSelection: Effect.succeed(
        options.model === undefined ? null : { instanceId, modelId }
      ),
      setDefault: () => Effect.succeed(true),
      rememberToolSupport: (p, m, support) =>
        Effect.sync(() => void memo.set(`${p}:${m}`, support)),
    };
    return api;
  });

export const fakeSecureStoreLayer = (): Layer.Layer<SecureStore> =>
  Layer.sync(SecureStore, () => {
    const secrets = new Map<string, string>();
    const api: SecureStoreService = {
      setSecret: (key, value) => Effect.sync(() => void secrets.set(key, value)),
      getSecret: key => Effect.sync(() => secrets.get(key) ?? null),
      deleteSecret: key => Effect.sync(() => void secrets.delete(key)),
    };
    return api;
  });

/**
 * A ModelManager whose only real answer is `installedPath` (from `installed`:
 * modelId → absolute path); every verb is an inert no-op and `state` is an
 * empty catalogue snapshot.
 */
export const fakeModelManagerLayer = (
  installed: Record<string, string> = {}
): Layer.Layer<ModelManager> =>
  Layer.effect(
    ModelManager,
    Effect.gen(function* () {
      const empty: ModelsStateView = { models: [], modelsDir: '/fake/models' };
      const state = yield* SubscriptionRef.make(empty);
      const api: ModelManagerApi = {
        state,
        list: SubscriptionRef.get(state),
        download: () => Effect.void,
        cancel: () => Effect.void,
        delete: () => Effect.void,
        reconcile: Effect.succeed({ removed: 0, adopted: 0, partsDeleted: 0 }),
        installedPath: modelId => Effect.succeed(Option.fromNullable(installed[modelId])),
      };
      return api;
    })
  );

export interface FakeWhisperCall {
  readonly audio16k: Float32Array;
  readonly options: WhisperDecodeOptions;
}

export interface FakeWhisperEngine {
  readonly layer: Layer.Layer<WhisperEngine>;
  /** Every `ensureModel` path, in order. */
  readonly ensureCalls: string[];
  /** Every `transcribe` call (the 16 kHz samples + the exact decode options), in order. */
  readonly transcribeCalls: FakeWhisperCall[];
  readonly disposeCount: () => number;
  /** Script the NEXT transcribe (default: an empty transcription). */
  readonly setTranscribeResponder: (
    fn: (call: FakeWhisperCall) => WorkerTranscription | WhisperEngineError
  ) => void;
  /** Script the NEXT ensureModel (default: succeeds). */
  readonly setEnsureResponder: (fn: (modelPath: string) => WhisperEngineError | null) => void;
}

/**
 * A scriptable WhisperEngine (no worker, no sidecar, no model) — records what
 * the local lane hands it and answers whatever the test scripted.
 */
export const makeFakeWhisperEngine = (): FakeWhisperEngine => {
  const ensureCalls: string[] = [];
  const transcribeCalls: FakeWhisperCall[] = [];
  let disposes = 0;
  let transcribeResponder: (
    call: FakeWhisperCall
  ) => WorkerTranscription | WhisperEngineError = () => ({ text: '', segments: [] });
  let ensureResponder: (modelPath: string) => WhisperEngineError | null = () => null;
  const api: WhisperEngineApi = {
    ensureModel: modelPath =>
      Effect.suspend(() => {
        ensureCalls.push(modelPath);
        const error = ensureResponder(modelPath);
        return error === null ? Effect.void : Effect.fail(error);
      }),
    transcribe: (audio16k, options) =>
      Effect.suspend(() => {
        const call: FakeWhisperCall = { audio16k, options };
        transcribeCalls.push(call);
        const answer = transcribeResponder(call);
        return answer instanceof WhisperEngineError ? Effect.fail(answer) : Effect.succeed(answer);
      }),
    dispose: Effect.sync(() => {
      disposes += 1;
    }),
  };
  return {
    layer: Layer.succeed(WhisperEngine, api),
    ensureCalls,
    transcribeCalls,
    disposeCount: () => disposes,
    setTranscribeResponder: fn => {
      transcribeResponder = fn;
    },
    setEnsureResponder: fn => {
      ensureResponder = fn;
    },
  };
};

/**
 * Complete WorkspaceLayerEnv additions in one merge for harnesses
 * that build a whole workspace and do not care about the engine (cloud default).
 */
export const workspaceEnvStubs = (
  mode: AppMode = 'cloud',
  settings: Partial<DeviceSettings> = {}
): Layer.Layer<
  | SettingsService
  | SecureStore
  | AppModeService
  | ModelManager
  | WhisperEngine
  | AiProvider
  | TelemetryService
> =>
  Layer.mergeAll(
    testTelemetryLayer,
    makeFakeSettings(settings).layer,
    fakeSecureStoreLayer(),
    fakeModelManagerLayer(),
    makeFakeWhisperEngine().layer,
    fakeAiProviderLayer(),
    Layer.effect(AppModeService, makeAppMode(mode, true))
  );

/**
 * The production Transcriber composition over a (fake) WorkspaceBackend: the
 * REAL cloud lane (so the fake's `uploadCalls` keep recording the WAV + params
 * exactly as before the seam) and placeholder local/BYOK lanes unless a test
 * injects its own implementation.
 */
export const makeTranscriberStack = (
  backend: Layer.Layer<WorkspaceBackend>,
  lanes: {
    readonly local?: Layer.Layer<LocalTranscriberLane, never, MainLogger>;
    readonly byok?: Layer.Layer<ByokTranscriberLane, never, MainLogger>;
  } = {}
): Layer.Layer<Transcriber, never, MainLogger> =>
  TranscriberLive.pipe(
    Layer.provide(CloudTranscriberLive.pipe(Layer.provide(backend))),
    Layer.provide(lanes.local ?? LocalTranscriberPlaceholderLive),
    Layer.provide(lanes.byok ?? ByokTranscriberPlaceholderLive)
  );
