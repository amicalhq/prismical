import { desktopFetch } from '../../infra/http/client';
import { Clock, Effect, Layer, Ref } from 'effect';
import type { LanguageModel } from 'ai';
import type { AiModelListing, AiProviderKind, AiProviderSetting } from '@prismical/desktop-contracts';
import { AppConfig } from '../../infra/config/service';
import { MainLogger } from '../../infra/logging/service';
import { SecureStore } from '../../infra/secure-store/service';
import { SettingsService } from '../settings/service';
import { fetchModelListing, PROVIDER_DEFAULTS, type FetchLike } from './catalogue';
import { AI_PROVIDER_KINDS, localInstanceId, PROVIDER_LABELS, providerOfInstanceId } from './instances';
import { createE2EFakeModel, E2E_FAKE_MODEL_ID } from './e2e-fake-model';
import { buildLanguageModel } from './models';
import { aiProviderSecretKey } from './secrets';
import {
  AiProvider,
  AiProviderError,
  type AiInstanceView,
  type AiModelSelection,
  type AiProviderApi,
  type ResolvedAiModel,
  type ToolSupport,
} from './service';

export interface AiProviderLiveOptions {
  /** Injected for tests; defaults to the ambient main-process fetch (Node's undici). */
  readonly fetchFn?: FetchLike;
  /** How long a provider's catalogue is served from memory. */
  readonly catalogueTtlMs?: number;
  /** A scripted model in place of every real provider (tests; AppConfig.e2eFakeAi selects the e2e one). */
  readonly fakeModel?: () => Promise<LanguageModel>;
  /** How long a learned tool-support downgrade is honoured before the ladder re-probes. */
  readonly toolSupportTtlMs?: number;
}

/** A successful listing is reused for this long; a failed one is retried after a shorter hold. */
const CATALOGUE_TTL_MS = 5 * 60_000;
const CATALOGUE_ERROR_TTL_MS = 30_000;
/** The synthetic instance rows cap the catalogue so the picker stays scannable. */
const INSTANCE_MODEL_CAP = 60;
/**
 * A learned downgrade ('auto-only' / 'none') expires so a provider or model
 * that gains tool support is re-probed; 'native' is never a downgrade and
 * needs no expiry.
 */
const TOOL_SUPPORT_TTL_MS = 30 * 60_000;

interface CachedListing {
  readonly at: number;
  readonly baseUrl: string | null;
  readonly listing: AiModelListing;
}

interface MemoEntry {
  readonly support: ToolSupport;
  readonly at: number;
}

export const makeAiProviderLive = (
  options: AiProviderLiveOptions = {}
): Layer.Layer<AiProvider, never, AppConfig | SettingsService | SecureStore | MainLogger> =>
  Layer.effect(
    AiProvider,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const settings = yield* SettingsService;
      const secrets = yield* SecureStore;
      const log = (yield* MainLogger).scoped('ai-provider');
      const fetchFn: FetchLike = options.fetchFn ?? desktopFetch;
      const ttl = options.catalogueTtlMs ?? CATALOGUE_TTL_MS;
      const memoTtl = options.toolSupportTtlMs ?? TOOL_SUPPORT_TTL_MS;
      // The scripted seam: every provider resolves to the fake, the catalogue
      // is the one fake id, keys are irrelevant. e2e-only by AppConfig gate.
      const fakeModel = options.fakeModel ?? (config.e2eFakeAi ? createE2EFakeModel : undefined);
      if (fakeModel !== undefined) yield* log.warn('AiProvider is serving the scripted fake model');

      const catalogues = yield* Ref.make(new Map<AiProviderKind, CachedListing>());
      const toolSupport = yield* Ref.make(new Map<string, MemoEntry>());

      // A SecureStore failure (safeStorage unavailable / decrypt failed / DB)
      // reads as "no key" — the lane cannot run without it either way. The
      // tag is logged, never the reason text (it could describe the value).
      const readKey = (provider: AiProviderKind): Effect.Effect<string | null> =>
        secrets.getSecret(aiProviderSecretKey(provider)).pipe(
          Effect.map(value => (value === null || value === '' ? null : value)),
          Effect.catchAll(error =>
            log.warn('provider key unreadable', { context: { provider }, error: error._tag }).pipe(Effect.as(null))
          )
        );

      const settingFor = (
        provider: AiProviderKind,
        setting: AiProviderSetting
      ): { baseUrl: string | null; model: string | null } => ({
        // The base URL / model knobs belong to the provider the record names;
        // another provider runs on its own defaults.
        baseUrl:
          (setting.provider === provider ? setting.baseUrl : null) ??
          PROVIDER_DEFAULTS[provider].baseUrl,
        model:
          (setting.provider === provider ? setting.model : null) ??
          PROVIDER_DEFAULTS[provider].model,
      });

      const listModels: AiProviderApi['listModels'] = (provider, force = false) =>
        Effect.gen(function* () {
          if (fakeModel !== undefined) return { models: [E2E_FAKE_MODEL_ID], error: null };
          const setting = (yield* settings.get).ai;
          const { baseUrl } = settingFor(provider, setting);
          const now = yield* Clock.currentTimeMillis;
          const cached = force ? undefined : (yield* Ref.get(catalogues)).get(provider);
          if (cached !== undefined && cached.baseUrl === baseUrl) {
            const hold = cached.listing.error === null ? ttl : CATALOGUE_ERROR_TTL_MS;
            if (now - cached.at < hold) return cached.listing;
          }
          const apiKey = yield* readKey(provider);
          const listing = yield* Effect.promise(() =>
            fetchModelListing({ provider, baseUrl, apiKey, fetchFn })
          );
          // A not-configured answer costs no network and is stale the moment a
          // key or base URL lands — never cache it (the settings card re-lists
          // right after a save).
          if (listing.error !== 'not-configured') {
            yield* Ref.update(catalogues, map => new Map(map).set(provider, { at: now, baseUrl, listing }));
          }
          if (listing.error !== null) {
            yield* log.info('model catalogue unavailable', { context: { provider }, error: listing.error });
          }
          return listing;
        });

      /** Whether a provider can run at all: key / base URL present, or (Ollama) reachable. */
      const configured = (
        provider: AiProviderKind,
        setting: AiProviderSetting
      ): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const defaults = PROVIDER_DEFAULTS[provider];
          if (defaults.needsKey) return (yield* readKey(provider)) !== null;
          if (defaults.needsBaseUrl) return settingFor(provider, setting).baseUrl !== null;
          // Ollama needs neither — it is "configured" when the runtime answers.
          return (yield* listModels(provider)).error === null;
        });

      const effectiveModel = (
        provider: AiProviderKind,
        setting: AiProviderSetting
      ): Effect.Effect<string | null> =>
        Effect.gen(function* () {
          const named = settingFor(provider, setting).model;
          if (named !== null) return named;
          // No default for this provider (openai-compatible / ollama): the
          // first catalogue entry stands in so a fresh install still runs.
          const listing = yield* listModels(provider);
          return listing.models[0] ?? null;
        });

      const instances: AiProviderApi['instances'] = Effect.gen(function* () {
        const setting = (yield* settings.get).ai;
        const rows: AiInstanceView[] = [];
        for (const provider of AI_PROVIDER_KINDS) {
          const active = provider === setting.provider;
          if (!active && (fakeModel !== undefined || !(yield* configured(provider, setting)))) continue;
          const listing = yield* listModels(provider);
          const chosen = settingFor(provider, setting).model;
          const models = [
            ...(chosen !== null ? [chosen] : []),
            ...listing.models.filter(id => id !== chosen).slice(0, INSTANCE_MODEL_CAP),
          ];
          rows.push({
            instanceId: localInstanceId(provider),
            provider,
            label: PROVIDER_LABELS[provider],
            models,
          });
        }
        return rows;
      });

      const defaultSelection: AiProviderApi['defaultSelection'] = Effect.gen(function* () {
        const setting = (yield* settings.get).ai;
        const modelId =
          fakeModel !== undefined ? E2E_FAKE_MODEL_ID : yield* effectiveModel(setting.provider, setting);
        return modelId === null ? null : { instanceId: localInstanceId(setting.provider), modelId };
      });

      const setDefault: AiProviderApi['setDefault'] = selection =>
        Effect.gen(function* () {
          const provider = providerOfInstanceId(selection.instanceId);
          if (provider === null) return false;
          const current = (yield* settings.get).ai;
          yield* settings.set({
            ai: {
              provider,
              model: selection.modelId,
              baseUrl: current.provider === provider ? current.baseUrl : null,
            },
          });
          return true;
        });

      // For openai-compatible / ollama the base URL IS the server identity and
      // model ids repeat across servers — it belongs in the key.
      const memoKey = (provider: AiProviderKind, baseUrl: string | null, modelId: string): string =>
        `${provider}:${baseUrl ?? 'default'}:${modelId}`;

      /** The remembered support, or 'unknown' once a downgrade has aged out. */
      const recall = (
        provider: AiProviderKind,
        baseUrl: string | null,
        modelId: string
      ): Effect.Effect<ToolSupport> =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(toolSupport)).get(memoKey(provider, baseUrl, modelId));
          if (entry === undefined) return 'unknown';
          if (entry.support === 'native') return 'native';
          const now = yield* Clock.currentTimeMillis;
          return now - entry.at < memoTtl ? entry.support : 'unknown';
        });

      const resolve: AiProviderApi['resolve'] = (selection = {}) =>
        Effect.gen(function* () {
          const setting = (yield* settings.get).ai;
          let provider: AiProviderKind = setting.provider;
          if (selection.instanceId !== undefined) {
            const named = providerOfInstanceId(selection.instanceId);
            if (named === null) {
              return yield* Effect.fail(
                new AiProviderError({ reason: 'unknown-instance', provider: null })
              );
            }
            provider = named;
          }
          if (fakeModel !== undefined) {
            const modelId = selection.modelId ?? E2E_FAKE_MODEL_ID;
            const model = yield* Effect.promise(fakeModel);
            const fake: ResolvedAiModel = {
              provider,
              modelId,
              instanceId: localInstanceId(provider),
              model,
              toolSupport: 'native',
            };
            return fake;
          }
          const modelId =
            selection.modelId ?? (yield* effectiveModel(provider, setting)) ?? null;
          if (modelId === null) {
            return yield* Effect.fail(new AiProviderError({ reason: 'model-required', provider }));
          }
          const defaults = PROVIDER_DEFAULTS[provider];
          const apiKey = yield* readKey(provider);
          const { baseUrl } = settingFor(provider, setting);
          if ((defaults.needsKey && apiKey === null) || (defaults.needsBaseUrl && baseUrl === null)) {
            return yield* Effect.fail(new AiProviderError({ reason: 'not-configured', provider }));
          }
          const model = buildLanguageModel({ provider, modelId, apiKey, baseUrl, fetchFn });
          const support = yield* recall(provider, baseUrl, modelId);
          const resolved: ResolvedAiModel = {
            provider,
            modelId,
            instanceId: localInstanceId(provider),
            model,
            toolSupport: support,
          };
          return resolved;
        });

      const rememberToolSupport: AiProviderApi['rememberToolSupport'] = (
        provider,
        modelId,
        support
      ) =>
        Effect.gen(function* () {
          const setting = (yield* settings.get).ai;
          const { baseUrl } = settingFor(provider, setting);
          const at = yield* Clock.currentTimeMillis;
          yield* Ref.update(toolSupport, map =>
            new Map(map).set(memoKey(provider, baseUrl, modelId), { support, at })
          );
          yield* log.info('tool support recorded', { context: { provider, model: modelId, support } });
        });

      const forget: AiProviderApi['forget'] = provider =>
        Effect.gen(function* () {
          yield* Ref.update(catalogues, map => {
            const next = new Map(map);
            next.delete(provider);
            return next;
          });
          yield* Ref.update(toolSupport, map => {
            const next = new Map(map);
            for (const key of next.keys()) if (key.startsWith(`${provider}:`)) next.delete(key);
            return next;
          });
        });

      const api: AiProviderApi = {
        resolve,
        listModels,
        forget,
        instances,
        defaultSelection,
        setDefault,
        rememberToolSupport,
      };
      return api;
    })
  );

export const AiProviderLive = makeAiProviderLive();

export type { AiModelSelection };
