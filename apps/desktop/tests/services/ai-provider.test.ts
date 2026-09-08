/**
 * AiProvider: provider resolution over the `ai` device setting
 * + per-provider secure-store keys, the synthetic local instances, the live
 * catalogue rules, and the tool-support memo. Fetch is injected: no network.
 */
import { assert, describe, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import * as contracts from '@prismical/desktop-contracts';
import {
  fetchModelListing,
  isOpenAiChatModel,
  ollamaChatBaseUrl,
  ollamaHost,
  type FetchLike,
} from '../../src/main/domains/ai-provider/catalogue';
import { localInstanceId, providerOfInstanceId } from '../../src/main/domains/ai-provider/instances';
import { makeAiProviderLive } from '../../src/main/domains/ai-provider/live';
import { aiProviderSecretKey } from '../../src/main/domains/ai-provider/secrets';
import { AiProvider } from '../../src/main/domains/ai-provider/service';
import { SettingsServiceLive } from '../../src/main/domains/settings/live';
import { SettingsService } from '../../src/main/domains/settings/service';
import { SecureStore } from '../../src/main/infra/secure-store/service';
import { makeFakeOperationalDb } from '../helpers/fake-operational-db';
import { fakeSecureStoreLayer } from '../helpers/fake-workspace-env';
import { makeTestLogger, testConfigLayer } from '../helpers/test-layers';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers per URL substring and records every request it saw. */
const makeFetch = (routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([needle]) => url.includes(needle));
    if (hit === undefined) return Promise.reject(new Error(`no route for ${url}`));
    return Promise.resolve(hit[1](init));
  };
  return { fetchFn, calls };
};

const build = (fetchFn: FetchLike, options: { toolSupportTtlMs?: number } = {}) => {
  const logger = makeTestLogger();
  const db = makeFakeOperationalDb();
  const settings = SettingsServiceLive.pipe(Layer.provide(db.layer), Layer.provide(logger.layer));
  const secureStore = fakeSecureStoreLayer();
  const provider = makeAiProviderLive({ fetchFn, ...options }).pipe(
    Layer.provide(testConfigLayer()),
    Layer.provide(settings),
    Layer.provide(secureStore),
    Layer.provide(logger.layer)
  );
  return { logger, layer: Layer.mergeAll(settings, secureStore, provider) };
};

describe('catalogue rules', () => {
  it('keeps OpenAI chat families and drops modality models', () => {
    for (const id of ['gpt-5', 'gpt-5-mini', 'o3', 'chatgpt-4o-latest', 'gpt-4.1']) {
      expect(isOpenAiChatModel(id), id).toBe(true);
    }
    for (const id of [
      'gpt-4o-audio-preview',
      'gpt-4o-realtime-preview',
      'text-embedding-3-small',
      'whisper-1',
      'gpt-image-1',
      'gpt-4o-transcribe',
      'omni-moderation-latest',
      'gpt-3.5-turbo-instruct',
      'dall-e-3',
    ]) {
      expect(isOpenAiChatModel(id), id).toBe(false);
    }
  });

  it('normalises Ollama hosts: chat under /v1, tags at the root', () => {
    expect(ollamaChatBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1');
    expect(ollamaChatBaseUrl('http://box:11434/v1/')).toBe('http://box:11434/v1');
    expect(ollamaHost('http://box:11434/v1')).toBe('http://box:11434');
  });

  it('lists per provider with the right endpoint + auth, never throwing', async () => {
    const { fetchFn, calls } = makeFetch({
      'api.openai.com/v1/models': () =>
        json({ data: [{ id: 'gpt-5' }, { id: 'whisper-1' }, { id: 'gpt-4.1' }] }),
      'api.anthropic.com/v1/models': () =>
        json({ data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] }),
      'localhost:11434/api/tags': () => json({ models: [{ name: 'llama3.2:3b' }] }),
      'compat.example/v1/models': () => json({ data: [{ id: 'local-model' }] }),
    });
    expect(
      await fetchModelListing({ provider: 'openai', baseUrl: null, apiKey: 'sk-1', fetchFn })
    ).toEqual({ models: ['gpt-4.1', 'gpt-5'], error: null });
    expect(
      await fetchModelListing({ provider: 'anthropic', baseUrl: null, apiKey: 'sk-ant', fetchFn })
    ).toEqual({ models: ['claude-opus-5', 'claude-sonnet-5'], error: null });
    expect(
      await fetchModelListing({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        apiKey: null,
        fetchFn,
      })
    ).toEqual({ models: ['llama3.2:3b'], error: null });
    expect(
      await fetchModelListing({
        provider: 'openai-compatible',
        baseUrl: 'http://compat.example/v1/',
        apiKey: null,
        fetchFn,
      })
    ).toEqual({ models: ['local-model'], error: null });

    const headers = (i: number) => calls[i]!.init?.headers as Record<string, string>;
    expect(headers(0).Authorization).toBe('Bearer sk-1');
    expect(headers(1)['x-api-key']).toBe('sk-ant');
    expect(headers(1)['anthropic-version']).toBeTypeOf('string');
    expect(headers(2)).toEqual({});
    expect(headers(3)).toEqual({});
  });

  it('folds failures to a reason: not-configured, unauthorized, network', async () => {
    const { fetchFn } = makeFetch({
      'api.openai.com': () => json({ error: 'nope' }, 401),
      'api.anthropic.com': () => json({ error: 'boom' }, 500),
    });
    expect(
      await fetchModelListing({ provider: 'openai', baseUrl: null, apiKey: null, fetchFn })
    ).toEqual({ models: [], error: 'not-configured' });
    expect(
      await fetchModelListing({
        provider: 'openai-compatible',
        baseUrl: null,
        apiKey: 'k',
        fetchFn,
      })
    ).toEqual({ models: [], error: 'not-configured' });
    expect(
      await fetchModelListing({ provider: 'openai', baseUrl: null, apiKey: 'sk', fetchFn })
    ).toEqual({ models: [], error: 'unauthorized' });
    expect(
      await fetchModelListing({ provider: 'anthropic', baseUrl: null, apiKey: 'sk', fetchFn })
    ).toEqual({ models: [], error: 'network' });
    expect(
      await fetchModelListing({
        provider: 'ollama',
        baseUrl: 'http://nowhere:1',
        apiKey: null,
        fetchFn,
      })
    ).toEqual({ models: [], error: 'network' });
  });
});

describe('local instance ids', () => {
  it('round-trip every provider kind and reject foreign ids', () => {
    for (const kind of ['openai', 'anthropic', 'openai-compatible', 'ollama'] as const) {
      expect(providerOfInstanceId(localInstanceId(kind))).toBe(kind);
    }
    expect(providerOfInstanceId('inst_abc123')).toBeNull();
    expect(providerOfInstanceId('inst_local_groq')).toBeNull();
    expect(providerOfInstanceId('prismical-cloud')).toBeNull();
  });
});

describe('AiProviderLive', () => {
  // Exercise the implemented adapters independently of their public rollout state.
  beforeEach(() => vi.spyOn(contracts, 'isLocalAiProviderEnabled').mockReturnValue(true));
  afterEach(() => vi.restoreAllMocks());
  it.effect('resolve fails not-configured until a key is stored, then builds the model', () =>
    Effect.gen(function* () {
      const { fetchFn } = makeFetch({});
      const { layer } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const secrets = Context.get(ctx, SecureStore);

      const missing = yield* Effect.flip(ai.resolve());
      assert.strictEqual(missing.reason, 'not-configured');
      assert.strictEqual(missing.provider, 'openai');

      yield* secrets.setSecret(aiProviderSecretKey('openai'), 'sk-test');
      const resolved = yield* ai.resolve();
      assert.strictEqual(resolved.provider, 'openai');
      assert.strictEqual(resolved.modelId, 'gpt-5'); // the provider default
      assert.strictEqual(resolved.instanceId, localInstanceId('openai'));
      assert.strictEqual(resolved.toolSupport, 'unknown');
      assert.strictEqual(typeof resolved.model === 'object' ? resolved.model.modelId : null, 'gpt-5');
    }).pipe(Effect.scoped)
  );

  it.effect('a request selection names another configured provider + model', () =>
    Effect.gen(function* () {
      const { fetchFn } = makeFetch({});
      const { layer } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const secrets = Context.get(ctx, SecureStore);
      yield* secrets.setSecret(aiProviderSecretKey('anthropic'), 'sk-ant');

      const resolved = yield* ai.resolve({
        instanceId: localInstanceId('anthropic'),
        modelId: 'claude-sonnet-5',
      });
      assert.strictEqual(resolved.provider, 'anthropic');
      assert.strictEqual(resolved.modelId, 'claude-sonnet-5');

      const foreign = yield* Effect.flip(ai.resolve({ instanceId: 'inst_cloudrow', modelId: 'x' }));
      assert.strictEqual(foreign.reason, 'unknown-instance');
    }).pipe(Effect.scoped)
  );

  it.effect('a keyless provider without a model borrows the first catalogue entry', () =>
    Effect.gen(function* () {
      const { fetchFn } = makeFetch({
        '/api/tags': () => json({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:3b' }] }),
      });
      const { layer } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const settings = Context.get(ctx, SettingsService);
      yield* settings.set({ ai: { provider: 'ollama', model: null, baseUrl: null } });

      const resolved = yield* ai.resolve();
      assert.strictEqual(resolved.provider, 'ollama');
      assert.strictEqual(resolved.modelId, 'llama3.2:3b'); // sorted catalogue, first entry
      const def = yield* ai.defaultSelection;
      assert.deepStrictEqual(def, { instanceId: localInstanceId('ollama'), modelId: 'llama3.2:3b' });
    }).pipe(Effect.scoped)
  );

  it.effect('instances list the active provider always and other providers only when configured', () =>
    Effect.gen(function* () {
      const { fetchFn, calls } = makeFetch({
        'api.anthropic.com': () => json({ data: [{ id: 'claude-opus-5' }] }),
        // Ollama unreachable → not listed (not the active provider).
      });
      const { layer } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const secrets = Context.get(ctx, SecureStore);
      const settings = Context.get(ctx, SettingsService);
      yield* secrets.setSecret(aiProviderSecretKey('anthropic'), 'sk-ant');
      yield* settings.set({ ai: { provider: 'openai', model: 'gpt-5-mini', baseUrl: null } });

      const rows = yield* ai.instances;
      assert.deepStrictEqual(
        rows.map(r => r.provider),
        ['openai', 'anthropic']
      );
      // The active provider has no key: its catalogue is empty but the chosen model leads.
      assert.deepStrictEqual(rows[0]!.models, ['gpt-5-mini']);
      assert.deepStrictEqual(rows[1]!.models, ['claude-opus-5']);
      assert.strictEqual(rows[1]!.label, 'Anthropic');

      // A second read within the TTL is served from memory (no new fetches).
      const before = calls.length;
      yield* ai.instances;
      assert.strictEqual(calls.length, before);
    }).pipe(Effect.scoped)
  );

  it.effect('a not-configured listing is never cached: the next list after a key lands fetches', () =>
    Effect.gen(function* () {
      const { fetchFn, calls } = makeFetch({
        'api.anthropic.com': () => json({ data: [{ id: 'claude-opus-5' }] }),
      });
      const { layer } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const secrets = Context.get(ctx, SecureStore);
      assert.deepStrictEqual(yield* ai.listModels('anthropic'), { models: [], error: 'not-configured' });
      assert.lengthOf(calls, 0);
      yield* secrets.setSecret(aiProviderSecretKey('anthropic'), 'sk-ant');
      assert.deepStrictEqual(yield* ai.listModels('anthropic'), { models: ['claude-opus-5'], error: null });
      assert.lengthOf(calls, 1);
    }).pipe(Effect.scoped)
  );

  it.effect('setDefault repoints the device setting; the tool-support memo persists', () =>
    Effect.gen(function* () {
      const { fetchFn } = makeFetch({});
      const { layer } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const settings = Context.get(ctx, SettingsService);
      const secrets = Context.get(ctx, SecureStore);
      yield* secrets.setSecret(aiProviderSecretKey('anthropic'), 'sk-ant');

      assert.isFalse(yield* ai.setDefault({ instanceId: 'inst_other', modelId: 'm' }));
      assert.isTrue(
        yield* ai.setDefault({ instanceId: localInstanceId('anthropic'), modelId: 'claude-opus-5' })
      );
      assert.deepStrictEqual((yield* settings.get).ai, {
        provider: 'anthropic',
        model: 'claude-opus-5',
        baseUrl: null,
      });

      yield* ai.rememberToolSupport('anthropic', 'claude-opus-5', 'auto-only');
      assert.strictEqual((yield* ai.resolve()).toolSupport, 'auto-only');
      assert.strictEqual(
        (yield* ai.resolve({ instanceId: localInstanceId('anthropic'), modelId: 'claude-sonnet-5' }))
          .toolSupport,
        'unknown'
      );
    }).pipe(Effect.scoped)
  );

  it.effect('the tool memo is keyed by endpoint, ages out downgrades, and is dropped by forget', () =>
    Effect.gen(function* () {
      const { fetchFn } = makeFetch({});
      const { layer } = build(fetchFn, { toolSupportTtlMs: 0 });
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const settings = Context.get(ctx, SettingsService);
      yield* settings.set({
        ai: { provider: 'openai-compatible', model: 'local-model', baseUrl: 'http://a.local/v1' },
      });
      // A native verdict never expires.
      yield* ai.rememberToolSupport('openai-compatible', 'local-model', 'native');
      assert.strictEqual((yield* ai.resolve()).toolSupport, 'native');
      // The same model id on ANOTHER server is a different memo entry.
      yield* settings.set({
        ai: { provider: 'openai-compatible', model: 'local-model', baseUrl: 'http://b.local/v1' },
      });
      assert.strictEqual((yield* ai.resolve()).toolSupport, 'unknown');
      // A downgrade ages out (ttl 0 → immediately) so the ladder re-probes.
      yield* ai.rememberToolSupport('openai-compatible', 'local-model', 'none');
      assert.strictEqual((yield* ai.resolve()).toolSupport, 'unknown');
      // forget drops the provider's entries entirely.
      yield* settings.set({
        ai: { provider: 'openai-compatible', model: 'local-model', baseUrl: 'http://a.local/v1' },
      });
      assert.strictEqual((yield* ai.resolve()).toolSupport, 'native');
      yield* ai.forget('openai-compatible');
      assert.strictEqual((yield* ai.resolve()).toolSupport, 'unknown');
    }).pipe(Effect.scoped)
  );

  it.effect('listModels(force) bypasses the cache; forget drops a cached listing', () =>
    Effect.gen(function* () {
      const { fetchFn, calls } = makeFetch({
        'api.anthropic.com': () => json({ data: [{ id: 'claude-opus-5' }] }),
      });
      const { layer } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const secrets = Context.get(ctx, SecureStore);
      yield* secrets.setSecret(aiProviderSecretKey('anthropic'), 'sk-ant');
      yield* ai.listModels('anthropic');
      yield* ai.listModels('anthropic');
      assert.lengthOf(calls, 1);
      yield* ai.listModels('anthropic', true);
      assert.lengthOf(calls, 2);
      yield* ai.forget('anthropic');
      yield* ai.listModels('anthropic');
      assert.lengthOf(calls, 3);
    }).pipe(Effect.scoped)
  );

  it.effect('never logs a key: catalogue and resolve paths log provider + tags only', () =>
    Effect.gen(function* () {
      const { fetchFn } = makeFetch({ 'api.openai.com': () => json({}, 401) });
      const { layer, logger } = build(fetchFn);
      const ctx = yield* Layer.build(layer);
      const ai = Context.get(ctx, AiProvider);
      const secrets = Context.get(ctx, SecureStore);
      const SENTINEL = 'sk-live-sentinel-9f1c';
      yield* secrets.setSecret(aiProviderSecretKey('openai'), SENTINEL);
      yield* ai.listModels('openai');
      yield* ai.resolve();
      assert.notInclude(JSON.stringify(logger.entries), SENTINEL);
    }).pipe(Effect.scoped)
  );
});

describe('local provider rollout', () => {
  for (const provider of ['anthropic', 'ollama', 'openai-compatible'] as const) {
    it.effect(`blocks saved and explicit ${provider} selections before any network request`, () =>
      Effect.gen(function* () {
        const { fetchFn, calls } = makeFetch({});
        const { layer } = build(fetchFn);
        const ctx = yield* Layer.build(layer);
        const ai = Context.get(ctx, AiProvider);
        const settings = Context.get(ctx, SettingsService);
        const secrets = Context.get(ctx, SecureStore);
        yield* secrets.setSecret(aiProviderSecretKey(provider), 'saved-key');
        const saved = { provider, model: 'saved-model', baseUrl: 'http://provider.test/v1' };
        yield* settings.set({ ai: saved });

        assert.strictEqual((yield* Effect.flip(ai.resolve())).reason, 'disabled');
        assert.strictEqual(
          (yield* Effect.flip(
            ai.resolve({ instanceId: localInstanceId(provider), modelId: 'model' })
          )).reason,
          'disabled'
        );
        assert.deepStrictEqual(yield* ai.listModels(provider, true), {
          models: [],
          error: 'not-configured',
        });
        assert.deepStrictEqual(yield* ai.instances, []);
        assert.isNull(yield* ai.defaultSelection);
        assert.isFalse(
          yield* ai.setDefault({ instanceId: localInstanceId(provider), modelId: 'model' })
        );
        assert.deepStrictEqual((yield* settings.get).ai, saved);
        assert.lengthOf(calls, 0);

        // Choosing an enabled provider restores access without deleting old settings or keys.
        yield* secrets.setSecret(aiProviderSecretKey('openai'), 'openai-key');
        assert.isTrue(
          yield* ai.setDefault({ instanceId: localInstanceId('openai'), modelId: 'gpt-5' })
        );
        assert.strictEqual((yield* ai.resolve()).provider, 'openai');
        assert.strictEqual(yield* secrets.getSecret(aiProviderSecretKey(provider)), 'saved-key');
      }).pipe(Effect.scoped)
    );
  }
});
