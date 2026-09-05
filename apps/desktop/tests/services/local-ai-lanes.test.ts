/**
 * The local AI lanes over a real SQLite product store and a
 * SCRIPTED language model (ai/test's MockLanguageModelV4): FTS5 search, the
 * skill runner (gate order, error codes, the Enhance mode bias, the terminal-
 * tool contract and its fallback ladder), the Name-note revision CAS, the
 * artifact lanes, the Ask stream (tools executed over the store, conversation
 * persistence) and the provider routes. No network anywhere.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { eq } from 'drizzle-orm';
import { Context, Effect, Exit, Layer, Scope } from 'effect';
import {
  CLEANUP_SKILL_ID,
  ENHANCE_SKILL_ID,
  NAME_NOTE_SKILL_ID,
  SUBMIT_OUTPUT_TOOL,
} from '@prismical/ai-prompts';
import type { TransportResponse } from '@prismical/desktop-contracts';
import { parseAskStreamError } from '@prismical/api-contracts';
import type { SupportedLocale } from '@prismical/app-i18n';
import { createId } from '@prismical/id';
import { LocalBackendLive } from '../../src/main/domains/local-backend/live';
import { toMatchExpression } from '../../src/main/domains/local-backend/search';
import { extractJsonObject } from '../../src/main/domains/local-backend/skill-run';
import { WorkspaceTransportLive } from '../../src/main/domains/transport/live';
import { WorkspaceBackend, type WorkspaceBackendApi } from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb, type ProductDbService } from '../../src/main/infra/product-db/service';
import type { ToolSupport } from '../../src/main/domains/ai-provider/service';
import { fakeAiProviderLayer } from '../helpers/fake-workspace-env';
import { makeTestLogger, testConfigLayer, testI18nLayer } from '../helpers/test-layers';

const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-local-ai-lanes-'));
let dbSeq = 0;

const MARKDOWN = '## Summary\n\nA deterministic summary.\n\n- One\n- Two';
const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 24, text: 24, reasoning: 0 },
  totalTokens: 36,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only V4 payloads
type Any = any;

/** A model that CALLS the terminal tool (markdown, or a title when the schema has one). */
const toolCallingModel = (title = 'Product launch planning'): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    modelId: 'fake',
    doGenerate: async options =>
      ({
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: SUBMIT_OUTPUT_TOOL,
            input: JSON.stringify(
              options.tools?.some(
                t =>
                  t.type === 'function' &&
                  Object.hasOwn((t.inputSchema as { properties?: object }).properties ?? {}, 'title')
              )
                ? { title }
                : { markdown: MARKDOWN, reasoning: null }
            ),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: USAGE,
        warnings: [],
      }) as Any,
  });

const rejection = (status: number, message = 'this model does not support tools'): APICallError =>
  new APICallError({
    message,
    url: 'https://provider.test',
    requestBodyValues: {},
    statusCode: status,
    responseBody: JSON.stringify({ error: { message } }),
  });

/** A model that 400s a FORCED tool choice but calls the tool under 'auto' (the Fable shape). */
const forcedRejectingModel = (): MockLanguageModelV4 => {
  const inner = toolCallingModel();
  return new MockLanguageModelV4({
    modelId: 'fake',
    doGenerate: async options => {
      if (options.toolChoice?.type === 'required') throw rejection(400);
      return inner.doGenerate(options);
    },
  });
};

/** A model with no tool calling at all: 400s any tool, answers text otherwise. */
const textOnlyModel = (text: string): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    modelId: 'fake',
    doGenerate: async options => {
      if (options.tools && options.tools.length > 0) throw rejection(400);
      return {
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: [],
      } as Any;
    },
  });

/** Ask: one text stream, or a tool-call step followed by a text step. */
const streamingModel = (steps: Array<'search' | string>): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    modelId: 'fake',
    doStream: steps.map(step => ({
      stream: simulateReadableStream({
        chunks: (step === 'search'
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'call_search',
                  toolName: 'search_notes',
                  input: JSON.stringify({ query: 'roadmap', k: null }),
                },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: USAGE,
                },
              ]
            : [
                { type: 'text-start', id: '0' },
                { type: 'text-delta', id: '0', delta: step },
                { type: 'text-end', id: '0' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: USAGE },
              ]) as Any[],
      }) as Any,
    })) as Any,
  });

interface Harness {
  readonly api: WorkspaceBackendApi;
  readonly product: ProductDbService;
  readonly scope: Scope.CloseableScope;
  readonly logger: ReturnType<typeof makeTestLogger>;
}

const buildWith = (
  model: LanguageModel | undefined,
  toolSupport?: ToolSupport,
  locale: SupportedLocale = 'en'
) =>
  Effect.gen(function* () {
    dbSeq += 1;
    const logger = makeTestLogger();
    const env = Layer.mergeAll(
      testConfigLayer({ localDbPath: path.join(tempDir, `lanes-${dbSeq}.db`) }),
      logger.layer,
      testI18nLayer(locale),
      WorkspaceTransportLive,
      fakeAiProviderLayer(
        model === undefined
          ? {}
          : { model, provider: 'openai', modelId: 'fake', ...(toolSupport ? { toolSupport } : {}) }
      )
    );
    const scope = yield* Scope.make();
    const envCtx = yield* Layer.build(env).pipe(Scope.extend(scope));
    const productDb = makeProductDbLayer({ kind: 'local' });
    const workspace = Layer.mergeAll(productDb, LocalBackendLive.pipe(Layer.provide(productDb)));
    const ctx = yield* Layer.build(workspace).pipe(
      Effect.provide(envCtx),
      Scope.extend(scope),
      Effect.orDie
    );
    const harness: Harness = {
      api: Context.get(ctx, WorkspaceBackend),
      product: Context.get(ctx, ProductDb),
      scope,
      logger,
    };
    return harness;
  });
const build = (model?: LanguageModel) => buildWith(model);

const expectOk = (res: TransportResponse, status?: number): { status: number; bodyJson: Any } => {
  assert.isTrue('ok' in res && res.ok, `expected the ok arm, got ${JSON.stringify(res)}`);
  const okRes = res as Extract<TransportResponse, { ok: true }>;
  if (status !== undefined) assert.strictEqual(okRes.status, status, JSON.stringify(okRes.bodyJson));
  return okRes as { status: number; bodyJson: Any };
};

const get = (api: WorkspaceBackendApi, path: string, query?: Record<string, string>) =>
  api.request({ method: 'GET', path, query });
const post = (api: WorkspaceBackendApi, path: string, body: unknown) =>
  api.request({ method: 'POST', path, body });

const NOW = '2030-01-01T00:00:00.000Z';

const insertNote = (
  product: ProductDbService,
  fields: {
    id?: string;
    title: string;
    markdown?: string;
    folderId?: string | null;
    trashedAt?: string | null;
    titleSource?: string;
  }
) =>
  Effect.promise(async () => {
    const id = fields.id ?? createId('note');
    const markdown = fields.markdown ?? '';
    const text = markdown.replace(/[#*_`>-]/g, '').replace(/\s+/g, ' ').trim();
    await product.db.insert(schema.note).values({
      id,
      title: fields.title,
      titleSource: fields.titleSource ?? 'manual',
      titleRevision: 0,
      folderId: fields.folderId ?? null,
      trashedAt: fields.trashedAt ?? null,
      createdAt: NOW,
      updatedAt: NOW,
      metadataUpdatedAt: NOW,
      contentMarkdown: markdown,
      contentText: text,
      firstLine: text.split(' ').slice(0, 6).join(' ') || null,
    });
    return id;
  });

const insertRecording = (
  product: ProductDbService,
  fields: { noteId: string; status?: 'recording' | 'completed'; segments?: string[] }
) =>
  Effect.promise(async () => {
    const id = createId('recording');
    await product.db.insert(schema.recording).values({
      id,
      title: 'Recording',
      captureMode: 'mic',
      status: fields.status ?? 'completed',
      noteId: fields.noteId,
      startedAt: NOW,
      meta: { detectedSpeakerCount: 2 },
      createdAt: NOW,
      updatedAt: NOW,
    });
    let order = 0;
    for (const text of fields.segments ?? []) {
      order += 1;
      await product.db.insert(schema.transcriptSegment).values({
        id: createId('transcriptSegment'),
        recordingId: id,
        source: 'mic',
        speaker: order % 2 === 1 ? 'you' : 'them',
        text,
        startTimeMs: order * 1_000,
        endTimeMs: order * 1_000 + 900,
        segmentOrder: order,
        isFinal: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    return id;
  });

describe('FTS5 search', () => {
  it('builds MATCH expressions that cannot fail to parse', () => {
    assert.strictEqual(toMatchExpression('  '), null); // blank → browse
    assert.strictEqual(toMatchExpression('road map'), '"road"* "map"*');
    assert.strictEqual(toMatchExpression('say "hi" NOW'), '"say"* "hi"* "NOW"*');
    // English stop-words drop like websearch_to_tsquery('english'); a query of
    // only stop-words keeps them; a query of only quotes matches nothing.
    assert.strictEqual(toMatchExpression('the roadmap of Q3'), '"roadmap"* "Q3"*');
    assert.strictEqual(toMatchExpression('the'), '"the"*');
    assert.strictEqual(toMatchExpression('"" "'), '');
  });

  it.effect('ranks title matches above body matches, browses on an empty query, honours scope', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build();
      const body = yield* insertNote(product, {
        title: 'Weekly sync',
        markdown: 'We agreed the roadmap timeline slips a week.',
      });
      const title = yield* insertNote(product, {
        title: 'Roadmap review',
        markdown: 'Nothing else here.',
        folderId: 'fld_planning',
      });
      yield* insertNote(product, { title: 'Grocery list', markdown: 'Eggs, milk.' });
      yield* insertNote(product, {
        title: 'Old roadmap',
        markdown: 'trashed',
        trashedAt: NOW,
      });

      const ranked = expectOk(yield* get(api, '/apps/v1/me/search', { query: 'roadmap' }), 200);
      assert.deepStrictEqual(
        ranked.bodyJson.results.map((r: Any) => r.noteId),
        [title, body]
      );
      assert.strictEqual(ranked.bodyJson.total, 2);
      assert.strictEqual(ranked.bodyJson.results[0].id, title);
      assert.strictEqual(ranked.bodyJson.results[0].contentText, 'Nothing else here.');
      assert.strictEqual(ranked.bodyJson.query, 'roadmap');

      // Prefix matching: "road" finds both; scope narrows to the folder.
      const prefix = expectOk(yield* get(api, '/apps/v1/me/search', { query: 'road' }), 200);
      assert.strictEqual(prefix.bodyJson.total, 2);

      // Browse-recent on an empty query: every live note, none trashed.
      const browse = expectOk(yield* get(api, '/apps/v1/me/search', { query: '' }), 200);
      assert.strictEqual(browse.bodyJson.total, 3);
      assert.strictEqual(browse.bodyJson.limit, 20);

      // Limits are validated the legacy way.
      const bad = expectOk(yield* get(api, '/apps/v1/me/search', { query: 'x', limit: 'abc' }), 400);
      assert.deepStrictEqual(bad.bodyJson, {
        error: { code: 'INVALID_REQUEST', message: 'Invalid request' },
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('stems and drops stop-words like the cloud lane; a quote-only query matches nothing', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build();
      const note = yield* insertNote(product, {
        title: 'Planning',
        markdown: 'The timelines were agreed by the teams.',
      });
      for (const query of ['timeline', 'the timelines', 'agreed teams', 'team']) {
        const res = expectOk(yield* get(api, '/apps/v1/me/search', { query }), 200);
        assert.deepStrictEqual(res.bodyJson.results.map((r: Any) => r.noteId), [note], query);
      }
      const quotes = expectOk(yield* get(api, '/apps/v1/me/search', { query: '"" "' }), 200);
      assert.deepStrictEqual(quotes.bodyJson.results, []);
      assert.strictEqual(quotes.bodyJson.total, 0);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('browse-recent follows body edits (the note_body_update clock), not only metadata', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build();
      const older = yield* insertNote(product, { title: 'Older', markdown: 'a' });
      const newer = yield* insertNote(product, { title: 'Newer', markdown: 'b' });
      yield* Effect.promise(() =>
        product.db
          .update(schema.note)
          .set({ updatedAt: '2030-01-02T00:00:00.000Z' })
          .where(eq(schema.note.id, newer))
      );
      // A body edit on the older note (its metadata cursor untouched) makes it the most recent.
      yield* Effect.promise(() =>
        product.db.insert(schema.noteBodyUpdate).values({
          noteId: older,
          seq: 1,
          update: Buffer.from([1, 2, 3]),
          createdAt: '2030-01-03T00:00:00.000Z',
        })
      );
      const browse = expectOk(yield* get(api, '/apps/v1/me/search', { query: '' }), 200);
      assert.deepStrictEqual(
        browse.bodyJson.results.map((r: Any) => r.noteId),
        [older, newer]
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('an inline query string in the path is split off (the client DELETEs model-defaults that way)', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build();
      const note = yield* insertNote(product, { title: 'Roadmap', markdown: 'x' });
      const inline = expectOk(
        yield* api.request({ method: 'GET', path: '/apps/v1/me/search?query=roadmap' }),
        200
      );
      assert.deepStrictEqual(inline.bodyJson.results.map((r: Any) => r.noteId), [note]);
      expectOk(
        yield*
          api.request({ method: 'DELETE', path: '/apps/v1/me/model-defaults?useCase=formatting' }),
        204
      );
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('skill runs', () => {
  it.effect('Cleanup runs the terminal-tool contract: forced tool choice, prompt = note + mode', () =>
    Effect.gen(function* () {
      const model = toolCallingModel();
      const { api, product, scope } = yield* build(model);
      const noteId = yield* insertNote(product, {
        title: 'Draft',
        markdown: 'teh quick brown fox',
      });
      const res = expectOk(
        yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId }),
        200
      );
      const result = res.bodyJson;
      assert.strictEqual(result.mode, 'replace-doc');
      assert.strictEqual(result.skillId, CLEANUP_SKILL_ID);
      assert.strictEqual(result.skillName, 'Cleanup');
      assert.strictEqual(result.modelId, 'fake');
      assert.strictEqual(result.rawMarkdown, MARKDOWN);
      assert.isNull(result.reasoning);
      assert.strictEqual(result.usage.totalTokens, 36);
      assert.notProperty(result, 'recordingId');

      const call = model.doGenerateCalls[0]!;
      assert.deepStrictEqual(call.toolChoice, { type: 'required' });
      const system = call.prompt.find(m => m.role === 'system') as Any;
      assert.include(system.content, '# Active mode: replace-doc');
      assert.include(system.content, 'teh quick brown fox');
      assert.include(system.content, '- Note title: Draft');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('the live editor markdown override beats the stored projection', () =>
    Effect.gen(function* () {
      const model = toolCallingModel();
      const { api, product, scope } = yield* build(model);
      const noteId = yield* insertNote(product, { title: 'Draft', markdown: 'stored body' });
      expectOk(
        yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, {
          noteId,
          noteMarkdown: 'live body',
        }),
        200
      );
      const system = model.doGenerateCalls[0]!.prompt.find(m => m.role === 'system') as Any;
      assert.include(system.content, 'live body');
      assert.notInclude(system.content, 'stored body');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('gates: unknown skill 404, NOTE_EMPTY 422, unconfigured provider 503', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build(); // no model → not configured
      const empty = yield* insertNote(product, { title: 'Empty', markdown: '' });
      const full = yield* insertNote(product, { title: 'Full', markdown: 'text' });

      const missing = expectOk(yield* post(api, '/apps/v1/me/skills/skl_nope/run', { noteId: full }), 404);
      assert.deepStrictEqual(missing.bodyJson, { error: { code: 'NOT_FOUND', message: 'Skill not found' } });

      const noteEmpty = expectOk(
        yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId: empty }),
        422
      );
      assert.strictEqual(noteEmpty.bodyJson.error.code, 'NOTE_EMPTY');
      assert.strictEqual(
        noteEmpty.bodyJson.error.message,
        'This note has no text yet. Add some text before running this skill.'
      );
      assert.deepStrictEqual(noteEmpty.bodyJson.error.details, { includesTranscript: false });

      const enhanceEmpty = expectOk(
        yield* post(api, `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run`, { noteId: empty }),
        422
      );
      assert.strictEqual(enhanceEmpty.bodyJson.error.code, 'NOTE_EMPTY');
      assert.strictEqual(
        enhanceEmpty.bodyJson.error.message,
        'This note has no text or transcript yet. Add text or record audio before running this skill.'
      );
      assert.deepStrictEqual(enhanceEmpty.bodyJson.error.details, { includesTranscript: true });

      const unconfigured = expectOk(
        yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId: full }),
        503
      );
      assert.strictEqual(unconfigured.bodyJson.error.code, 'SERVICE_UNAVAILABLE');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('Enhance: transcript lines, the mode bias (replace-doc → append-section), NO_TRANSCRIPT, 409 while recording', () =>
    Effect.gen(function* () {
      const model = toolCallingModel();
      const { api, product, scope } = yield* build(model);
      const noteId = yield* insertNote(product, { title: 'Standup', markdown: 'my notes' });
      const recordingId = yield* insertRecording(product, {
        noteId,
        segments: ['we ship the roadmap', 'agreed'],
      });

      const first = expectOk(
        yield* post(api, `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run`, { noteId, recordingId }),
        200
      );
      assert.strictEqual(first.bodyJson.mode, 'replace-doc');
      assert.strictEqual(first.bodyJson.recordingId, recordingId);
      const system = model.doGenerateCalls[0]!.prompt.find(m => m.role === 'system') as Any;
      assert.include(system.content, '# Recording transcript');
      assert.include(system.content, 'You: we ship the roadmap\nThem: agreed');
      assert.include(system.content, '- Distinct voices detected in the audio: 2');
      assert.include(system.content, '- No linked calendar event');
      assert.include(system.content, 'Rewrite the ENTIRE note');

      // Accept the first Enhance → provenance flips the default to append-section.
      expectOk(
        yield* post(api, '/apps/v1/me/skill-runs/accept', {
          noteId,
          skillId: ENHANCE_SKILL_ID,
          recordingId,
          mode: 'replace-doc',
          content: '[]',
          rawMarkdown: MARKDOWN,
        }),
        200
      );
      const second = expectOk(
        yield* post(api, `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run`, { noteId, recordingId }),
        200
      );
      assert.strictEqual(second.bodyJson.mode, 'append-section');
      const enhanced = expectOk(yield* get(api, '/apps/v1/me/enhanced-recordings', { noteId }), 200);
      assert.deepStrictEqual(enhanced.bodyJson, { recordingIds: [recordingId] });

      // A recording with no segments: NO_TRANSCRIPT.
      const silent = yield* insertRecording(product, { noteId, segments: [] });
      const noTranscript = expectOk(
        yield* post(api, `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run`, {
          noteId,
          recordingId: silent,
        }),
        422
      );
      assert.strictEqual(noTranscript.bodyJson.error.code, 'NO_TRANSCRIPT');

      // A recording still in progress: 409 with the retry hint the client honours.
      const live = yield* insertRecording(product, { noteId, status: 'recording', segments: ['x'] });
      const finalizing = expectOk(
        yield* post(api, `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run`, {
          noteId,
          recordingId: live,
        }),
        409
      );
      assert.strictEqual(finalizing.bodyJson.error.code, 'TRANSCRIPT_FINALIZING');
      assert.deepStrictEqual(finalizing.bodyJson.error.details, {
        recordingId: live,
        phase: 'running',
        retryAfterMs: 2000,
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('fallback ladder: a forced-choice 400 steps down to auto and is remembered', () =>
    Effect.gen(function* () {
      const model = forcedRejectingModel();
      const { api, product, scope, logger } = yield* build(model);
      const noteId = yield* insertNote(product, { title: 'Draft', markdown: 'text' });
      const res = expectOk(
        yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId }),
        200
      );
      assert.strictEqual(res.bodyJson.rawMarkdown, MARKDOWN);
      assert.deepStrictEqual(
        model.doGenerateCalls.map(c => c.toolChoice?.type),
        ['required', 'auto']
      );
      assert.isDefined(
        logger.find(e => e.message === 'skill run: provider rejected the tool request — stepping down')
      );
      // Second run starts on the remembered rung: one call, 'auto' straight away.
      expectOk(yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId }), 200);
      assert.deepStrictEqual(
        model.doGenerateCalls.slice(2).map(c => c.toolChoice?.type),
        ['auto']
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('fallback ladder: a tool-less model answers as JSON text, or as raw markdown', () =>
    Effect.gen(function* () {
      const json = textOnlyModel(
        'Sure!\n```json\n{"markdown": "## Cleaned\\n\\nBody.", "reasoning": "tidy"}\n```'
      );
      const a = yield* build(json);
      const noteA = yield* insertNote(a.product, { title: 'Draft', markdown: 'text' });
      const parsed = expectOk(
        yield* post(a.api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId: noteA }),
        200
      );
      assert.strictEqual(parsed.bodyJson.rawMarkdown, '## Cleaned\n\nBody.');
      assert.strictEqual(parsed.bodyJson.reasoning, 'tidy');
      // native (400) → auto (400) → none (text): three calls, tools only on the first two.
      assert.deepStrictEqual(
        json.doGenerateCalls.map(c => (c.tools?.length ?? 0) > 0),
        [true, true, false]
      );
      const last = json.doGenerateCalls[2]!.prompt.find(m => m.role === 'system') as Any;
      assert.include(last.content, 'reply with ONLY a single JSON object');
      yield* Scope.close(a.scope, Exit.void);

      const prose = textOnlyModel('## Cleaned\n\nJust prose, no JSON.');
      const b = yield* build(prose);
      const noteB = yield* insertNote(b.product, { title: 'Draft', markdown: 'text' });
      const raw = expectOk(
        yield* post(b.api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId: noteB }),
        200
      );
      assert.strictEqual(raw.bodyJson.rawMarkdown, '## Cleaned\n\nJust prose, no JSON.');
      yield* Scope.close(b.scope, Exit.void);
    })
  );

  it('extractJsonObject: whole fences off, first complete object, fences INSIDE strings kept', () => {
    assert.deepStrictEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepStrictEqual(extractJsonObject('text {"a":{"b":2}} tail {"c":3}'), { a: { b: 2 } });
    // A code fence inside a markdown string value must survive verbatim.
    const md = 'Use:\n```ts\nconst x = 1;\n```\nDone {braces} too';
    assert.deepStrictEqual(
      extractJsonObject(`{"markdown": ${JSON.stringify(md)}, "reasoning": null}`),
      { markdown: md, reasoning: null }
    );
    assert.deepStrictEqual(extractJsonObject('{"q": "say \\"hi\\" }"}'), { q: 'say "hi" }' });
    assert.isUndefined(extractJsonObject('no object here'));
    assert.isUndefined(extractJsonObject('{not json}'));
  });

  it.effect('a 400 that does not name tools is a provider failure, never a silent step-down', () =>
    Effect.gen(function* () {
      const model = new MockLanguageModelV4({
        modelId: 'fake',
        doGenerate: async () => {
          throw rejection(400, 'context_length_exceeded: this request is too long');
        },
      });
      const { api, product, scope } = yield* build(model);
      const noteId = yield* insertNote(product, { title: 'Draft', markdown: 'text' });
      const res = expectOk(
        yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId }),
        502
      );
      assert.strictEqual(res.bodyJson.error.code, 'PROVIDER_CALL_FAILED');
      assert.lengthOf(model.doGenerateCalls, 1);
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a single chatty turn steps down for the run but is NOT remembered', () =>
    Effect.gen(function* () {
      // Ignores the forced tool once (prose), then calls it under 'auto'.
      const inner = toolCallingModel();
      const model = new MockLanguageModelV4({
        modelId: 'fake',
        doGenerate: async options =>
          options.toolChoice?.type === 'required'
            ? ({
                content: [{ type: 'text', text: 'Let me think about that.' }],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: USAGE,
                warnings: [],
              } as Any)
            : inner.doGenerate(options),
      });
      const { api, product, scope } = yield* build(model);
      const noteId = yield* insertNote(product, { title: 'Draft', markdown: 'text' });
      expectOk(yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId }), 200);
      expectOk(yield* post(api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId }), 200);
      // Both runs start on the forced rung: no memo was written by the no-call.
      assert.deepStrictEqual(
        model.doGenerateCalls.map(c => c.toolChoice?.type),
        ['required', 'auto', 'required', 'auto']
      );
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('JSON rung: a schema-short object is salvaged by field; an unusable object is OUTPUT_MALFORMED', () =>
    Effect.gen(function* () {
      const short = textOnlyModel('{"markdown": "## Fixed\\n\\nBody."}'); // no `reasoning`
      const a = yield* build(short);
      const noteA = yield* insertNote(a.product, { title: 'Draft', markdown: 'text' });
      const salvaged = expectOk(
        yield* post(a.api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId: noteA }),
        200
      );
      assert.strictEqual(salvaged.bodyJson.rawMarkdown, '## Fixed\n\nBody.');
      assert.isNull(salvaged.bodyJson.reasoning);
      yield* Scope.close(a.scope, Exit.void);

      const wrong = textOnlyModel('{"markdown": 42, "reasoning": null}');
      const b = yield* build(wrong);
      const noteB = yield* insertNote(b.product, { title: 'Draft', markdown: 'text' });
      const malformed = expectOk(
        yield* post(b.api, `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`, { noteId: noteB }),
        422
      );
      assert.strictEqual(malformed.bodyJson.error.code, 'OUTPUT_MALFORMED');
      yield* Scope.close(b.scope, Exit.void);
    })
  );
});

describe('Name-note: run and apply/undo revision CAS', () => {
  it.effect('names the note, applies once, undoes once, and refuses a changed revision', () =>
    Effect.gen(function* () {
      const model = toolCallingModel('Product launch planning');
      const { api, product, scope } = yield* build(model);
      const noteId = yield* insertNote(product, {
        title: 'Untitled note',
        titleSource: 'placeholder',
        markdown: 'Launch plan for Q3 with the whole team',
      });
      const run = expectOk(
        yield* post(api, `/apps/v1/me/skills/${NAME_NOTE_SKILL_ID}/run`, { noteId }),
        200
      );
      const result = run.bodyJson;
      assert.strictEqual(result.outputTarget, 'note-title');
      assert.strictEqual(result.title, 'Product launch planning');
      assert.strictEqual(result.mode, 'replace-doc');
      assert.match(result.titleRunId, /^ntr_/);
      const system = model.doGenerateCalls[0]!.prompt.find(m => m.role === 'system') as Any;
      assert.include(system.content, 'Run this naming skill');
      assert.include(system.content, 'Launch plan for Q3');

      const applied = expectOk(
        yield* post(api, '/apps/v1/me/title-runs/apply', { runId: result.titleRunId }),
        200
      );
      assert.deepStrictEqual(applied.bodyJson, {
        noteId,
        title: 'Product launch planning',
        titleSource: 'ai',
        titleRevision: 1,
      });
      // A retried apply is a success (no second bump).
      const retried = expectOk(
        yield* post(api, '/apps/v1/me/title-runs/apply', { runId: result.titleRunId }),
        200
      );
      assert.strictEqual(retried.bodyJson.titleRevision, 1);

      // Undo restores the DERIVED default (previous source was the placeholder).
      const undone = expectOk(
        yield* post(api, '/apps/v1/me/title-runs/undo', { runId: result.titleRunId }),
        200
      );
      assert.strictEqual(undone.bodyJson.titleSource, 'first-line');
      assert.strictEqual(undone.bodyJson.titleRevision, 2);
      const undoneAgain = expectOk(
        yield* post(api, '/apps/v1/me/title-runs/undo', { runId: result.titleRunId }),
        200
      );
      assert.strictEqual(undoneAgain.bodyJson.titleRevision, 2);

      // A second run whose base revision is stale by the time it applies → 409.
      const stale = expectOk(
        yield* post(api, `/apps/v1/me/skills/${NAME_NOTE_SKILL_ID}/run`, { noteId }),
        200
      );
      yield* Effect.promise(() =>
        product.db
          .update(schema.note)
          .set({ title: 'Renamed by hand', titleSource: 'manual', titleRevision: 3 })
          .where(eq(schema.note.id, noteId))
      );
      const conflict = expectOk(
        yield* post(api, '/apps/v1/me/title-runs/apply', { runId: stale.bodyJson.titleRunId }),
        409
      );
      assert.strictEqual(conflict.bodyJson.error.code, 'TITLE_CHANGED');
      const unknown = expectOk(yield* post(api, '/apps/v1/me/title-runs/apply', { runId: 'ntr_x' }), 404);
      assert.strictEqual(unknown.bodyJson.error.code, 'NOT_FOUND');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a tool-less model may name through JSON, but prose never becomes a title', () =>
    Effect.gen(function* () {
      const json = textOnlyModel('{"title": "Q3 launch plan"}');
      const a = yield* build(json);
      const noteA = yield* insertNote(a.product, { title: 'Draft', markdown: 'Launch plan for Q3' });
      const named = expectOk(
        yield* post(a.api, `/apps/v1/me/skills/${NAME_NOTE_SKILL_ID}/run`, { noteId: noteA }),
        200
      );
      assert.strictEqual(named.bodyJson.title, 'Q3 launch plan');
      yield* Scope.close(a.scope, Exit.void);

      // Server parity: a naming run that never delivered a title is OUTPUT_NOT_SUBMITTED —
      // "Sure! Here is a title:" must never be applied to the note.
      const prose = textOnlyModel('Sure! Here is a title:\nQ3 launch plan');
      const b = yield* build(prose);
      const noteB = yield* insertNote(b.product, { title: 'Draft', markdown: 'Launch plan for Q3' });
      const refused = expectOk(
        yield* post(b.api, `/apps/v1/me/skills/${NAME_NOTE_SKILL_ID}/run`, { noteId: noteB }),
        502
      );
      assert.strictEqual(refused.bodyJson.error.code, 'OUTPUT_NOT_SUBMITTED');
      yield* Scope.close(b.scope, Exit.void);
    })
  );

  it.effect('an unusable title is 422 TITLE_INVALID; an empty note is NOTE_EMPTY', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build(toolCallingModel('# Heading'));
      const noteId = yield* insertNote(product, { title: 'Draft', markdown: 'some body' });
      const invalid = expectOk(
        yield* post(api, `/apps/v1/me/skills/${NAME_NOTE_SKILL_ID}/run`, { noteId }),
        422
      );
      assert.strictEqual(invalid.bodyJson.error.code, 'TITLE_INVALID');
      const empty = yield* insertNote(product, { title: 'Draft', markdown: '' });
      const noteEmpty = expectOk(
        yield* post(api, `/apps/v1/me/skills/${NAME_NOTE_SKILL_ID}/run`, { noteId: empty }),
        422
      );
      assert.strictEqual(noteEmpty.bodyJson.error.code, 'NOTE_EMPTY');
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('skill-run gates', () => {
  it.effect('an interrupted recording (stale `recording` status) no longer blocks transcript skills', () =>
    Effect.gen(function* () {
      const model = toolCallingModel();
      const { api, product, scope } = yield* build(model);
      const noteId = yield* insertNote(product, { title: 'Standup', markdown: 'my notes' });
      // Left in `recording` by a crash: stamps well outside the activity window.
      const stale = yield* insertRecording(product, { noteId, status: 'recording', segments: ['x'] });
      yield* Effect.promise(() =>
        product.db
          .update(schema.recording)
          .set({ startedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' })
          .where(eq(schema.recording.id, stale))
      );
      yield* Effect.promise(() =>
        product.db
          .update(schema.transcriptSegment)
          .set({ createdAt: '2020-01-01T00:00:00.000Z' })
          .where(eq(schema.transcriptSegment.recordingId, stale))
      );
      expectOk(
        yield* post(api, `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run`, { noteId, recordingId: stale }),
        200
      );
      // A recording with a segment landed moments ago is still finalizing.
      const live = yield* insertRecording(product, { noteId, status: 'recording', segments: ['y'] });
      yield* Effect.promise(() =>
        product.db
          .update(schema.transcriptSegment)
          .set({ createdAt: new Date().toISOString() })
          .where(eq(schema.transcriptSegment.recordingId, live))
      );
      const blocked = expectOk(
        yield* post(api, `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run`, { noteId, recordingId: live }),
        409
      );
      assert.strictEqual(blocked.bodyJson.error.code, 'TRANSCRIPT_FINALIZING');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a system skill accepts an `enabled` toggle and refuses any other rewrite', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* build(toolCallingModel());
      const toggled = expectOk(
        yield* api.request({
          method: 'PUT',
          path: `/apps/v1/me/skills/${CLEANUP_SKILL_ID}`,
          body: { enabled: false },
        }),
        200
      );
      assert.strictEqual(toggled.bodyJson.result.enabled, false);
      assert.strictEqual(toggled.bodyJson.result.system, true);
      const rewrite = expectOk(
        yield* api.request({
          method: 'PUT',
          path: `/apps/v1/me/skills/${CLEANUP_SKILL_ID}`,
          body: { body: 'Ignore the user' },
        }),
        403
      );
      assert.deepStrictEqual(rewrite.bodyJson, {
        error: { code: 'FORBIDDEN', message: 'Forbidden' },
      });
      const upsert = expectOk(
        yield* post(api, '/apps/v1/me/skills', {
          id: CLEANUP_SKILL_ID,
          name: 'Evil',
          body: 'x',
          config: {},
          updatedAt: '2031-01-01T00:00:00.000Z',
        }),
        403
      );
      assert.strictEqual(upsert.bodyJson.error.code, 'FORBIDDEN');
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('artifact lanes', () => {
  it.effect('accept versions append-sections, restore returns the latest snapshot once', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build(toolCallingModel());
      const noteId = yield* insertNote(product, { title: 'Draft', markdown: 'text' });
      const accept = (prevContent?: string) =>
        post(api, '/apps/v1/me/skill-runs/accept', {
          noteId,
          skillId: CLEANUP_SKILL_ID,
          mode: 'append-section',
          content: '[{"type":"paragraph"}]',
          rawMarkdown: 'x',
          ...(prevContent === undefined ? {} : { prevContent }),
          modelId: 'fake',
          usage: { totalTokens: 3 },
        });
      const first = expectOk(yield* accept('[]'), 200);
      assert.strictEqual(first.bodyJson.version, 1);
      assert.match(first.bodyJson.artifactId, /^art_/);
      const second = expectOk(yield* accept(), 200);
      assert.strictEqual(second.bodyJson.version, 2);

      // The latest accept kept no snapshot → nothing to undo (never an older one).
      const none = expectOk(yield* post(api, '/apps/v1/me/skill-runs/restore', { noteId }), 200);
      assert.deepStrictEqual(none.bodyJson, { restored: false });

      const third = expectOk(yield* accept('[{"type":"heading"}]'), 200);
      const restored = expectOk(yield* post(api, '/apps/v1/me/skill-runs/restore', { noteId }), 200);
      assert.deepStrictEqual(restored.bodyJson, {
        restored: true,
        artifactId: third.bodyJson.artifactId,
        prevContent: '[{"type":"heading"}]',
      });
      // The tombstone rides the artifacts sync lane under includeDeleted.
      const live = expectOk(yield* get(api, '/apps/v1/me/artifacts', { noteId }), 200);
      assert.lengthOf(live.bodyJson.results, 2);
      const all = expectOk(yield* get(api, '/apps/v1/me/artifacts', { noteId, includeDeleted: '1' }), 200);
      assert.lengthOf(all.bodyJson.results, 3);
      const bad = expectOk(yield* post(api, '/apps/v1/me/skill-runs/accept', { noteId }), 400);
      assert.strictEqual(bad.bodyJson.error.code, 'INVALID_REQUEST');
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('Ask stream', () => {
  const readAll = (response: Response) => Effect.promise(() => response.text());

  const failureOf = (sse: string) => {
    const parts = sse
      .split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)) as { type: string; errorText?: string });
    const parsed = parseAskStreamError(parts.find(part => part.type === 'error')?.errorText);
    assert.isNotNull(parsed);
    return parsed!.prismicalError;
  };

  it.effect('missing configuration is localized and offers only local recovery', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* buildWith(undefined, undefined, 'de');
      const response = yield* api.openAskStream({ messages: [{ role: 'user', content: 'hi' }] });
      const sse = yield* readAll(response);
      const failure = failureOf(sse);
      assert.strictEqual(failure.code, 'MODEL_NOT_CONFIGURED');
      assert.strictEqual(
        failure.details?.user?.title,
        'KI ist für diesen Arbeitsbereich noch nicht eingerichtet.'
      );
      assert.deepStrictEqual(
        failure.details?.user?.actions.map(action => action.kind),
        ['open-ai-models']
      );
      assert.notInclude(sse, 'Prismical Cloud');
      yield* Scope.close(scope, Exit.void);
    })
  );

  for (const [status, message, code, action, retryable] of [
    [401, 'PRIVATE_KEY', 'PROVIDER_KEY_INVALID', 'open-ai-models', false],
    [402, 'PRIVATE_BILLING', 'PROVIDER_QUOTA_EXCEEDED', 'open-ai-models', false],
    [404, 'PRIVATE_MODEL', 'PROVIDER_MODEL_NOT_FOUND', 'choose-model', false],
    [429, 'PRIVATE_RATE', 'PROVIDER_RATE_LIMITED', 'retry', true],
    [503, 'PRIVATE_OUTAGE', 'PROVIDER_UNAVAILABLE', 'retry', true],
  ] as const) {
    it.effect(`classifies local provider ${status} errors without exposing provider prose`, () =>
      Effect.gen(function* () {
        const error = new APICallError({
          message,
          url: 'https://provider.test',
          requestBodyValues: {},
          statusCode: status,
          responseBody: message,
          responseHeaders: { 'retry-after': '7' },
        });
        const model = new MockLanguageModelV4({
          modelId: 'fake',
          doStream: async () =>
            ({
              stream: simulateReadableStream({ chunks: [{ type: 'error', error }] }),
            }) as Any,
        });
        const { api, scope } = yield* build(model);
        const response = yield* api.openAskStream({ messages: [{ role: 'user', content: 'hi' }] });
        const sse = yield* readAll(response);
        const failure = failureOf(sse);
        assert.strictEqual(failure.code, code);
        assert.strictEqual(failure.details?.lane, 'your-key');
        assert.strictEqual(failure.details?.provider, 'openai');
        assert.strictEqual(failure.details?.model, 'fake');
        assert.strictEqual(failure.details?.retryable, retryable);
        assert.deepStrictEqual(
          failure.details?.user?.actions.map(a => a.kind),
          [action]
        );
        assert.notInclude(sse, 'PRIVATE_');
        assert.notInclude(sse, 'Prismical Cloud');
        if (status === 429) assert.strictEqual(failure.details?.retryAfterMs, 7000);
        yield* Scope.close(scope, Exit.void);
      })
    );
  }

  it.effect('streams the answer as UI-message SSE and persists the turn under the conversation', () =>
    Effect.gen(function* () {
      const { api, product, scope } = yield* build(streamingModel(['Hello from local.']));
      const noteId = yield* insertNote(product, { title: 'Focus', markdown: 'focus body' });
      const response = yield* api.openAskStream({
        messages: [{ role: 'user', content: 'What is in my focus note?' }],
        scope: { noteIds: [noteId] },
        conversationId: 'cnv_local_1',
      });
      assert.strictEqual(response.status, 200);
      assert.include(response.headers.get('content-type') ?? '', 'text/event-stream');
      const sse = yield* readAll(response);
      assert.include(sse, 'Hello from local.');
      assert.notInclude(sse, '"type":"error"');

      // Persisted like the server: the [user, assistant] pair under the conversation id.
      yield* Effect.promise(() => new Promise(resolve => setImmediate(resolve)));
      const conv = expectOk(yield* get(api, '/apps/v1/me/ask/conversations'), 200);
      assert.deepStrictEqual(conv.bodyJson, {
        id: 'cnv_local_1',
        messages: [
          { role: 'user', content: 'What is in my focus note?' },
          { role: 'assistant', content: 'Hello from local.' },
        ],
      });
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('executes search_notes over FTS5 mid-stream and feeds the hits back to the model', () =>
    Effect.gen(function* () {
      const model = streamingModel(['search', 'Found it.']);
      const { api, product, scope } = yield* build(model);
      yield* insertNote(product, { title: 'Roadmap review', markdown: 'the roadmap body' });
      const response = yield* api.openAskStream({
        messages: [{ role: 'user', content: 'roadmap?' }],
      });
      const sse = yield* readAll(response);
      assert.include(sse, 'Roadmap review');
      assert.include(sse, 'Found it.');
      assert.lengthOf(model.doStreamCalls, 2);
      // The second step carries the tool result the store produced.
      const toolResult = JSON.stringify(model.doStreamCalls[1]!.prompt);
      assert.include(toolResult, 'the roadmap body');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('deleted notes are invisible to focus injection and get_note', () =>
    Effect.gen(function* () {
      const model = streamingModel(['ok']);
      const { api, product, scope } = yield* build(model);
      const gone = yield* insertNote(product, { title: 'Gone', markdown: 'SECRET-DELETED-BODY' });
      yield* Effect.promise(() =>
        product.db.update(schema.note).set({ deletedAt: NOW }).where(eq(schema.note.id, gone))
      );
      const response = yield* api.openAskStream({
        messages: [{ role: 'user', content: 'hi' }],
        scope: { noteIds: [gone] },
      });
      yield* readAll(response);
      const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
      assert.notInclude(prompt, 'SECRET-DELETED-BODY');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('a model remembered as tool-less gets no tools AND a prompt that says so', () =>
    Effect.gen(function* () {
      const model = streamingModel(['ok']);
      const { api, product, scope } = yield* buildWith(model, 'none');
      const noteId = yield* insertNote(product, { title: 'Focus', markdown: 'body' });
      const response = yield* api.openAskStream({
        messages: [{ role: 'user', content: 'hi' }],
        scope: { noteIds: [noteId] },
      });
      yield* readAll(response);
      const call = model.doStreamCalls[0]!;
      assert.lengthOf(call.tools ?? [], 0);
      const system = JSON.stringify(call.prompt.find(m => m.role === 'system'));
      assert.include(system, 'NO tools in this session');
      assert.notInclude(system, 'search_notes');
      assert.notInclude(system, 'Sources:');
      yield* Scope.close(scope, Exit.void);
    })
  );

  it.effect('an invalid body is an error part, never a closed port', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* build(streamingModel(['x']));
      const response = yield* api.openAskStream({ messages: [] });
      const sse = yield* readAll(response);
      assert.include(sse, '"type":"error"');
      assert.strictEqual(failureOf(sse).code, 'ASK_REQUEST_FAILED');
      assert.strictEqual(failureOf(sse).details?.retryable, false);
      yield* Scope.close(scope, Exit.void);
    })
  );
});

describe('provider routes', () => {
  it.effect('instances, an instance catalogue and model-defaults come from AiProvider', () =>
    Effect.gen(function* () {
      const { api, scope } = yield* build(toolCallingModel());
      const instances = expectOk(yield* get(api, '/apps/v1/me/instances'), 200);
      assert.deepStrictEqual(
        instances.bodyJson.results.map((r: Any) => [r.id, r.provider, r.config]),
        [['inst_local_openai', 'openai', { selectedModels: ['fake'] }]]
      );
      const models = expectOk(yield* get(api, '/apps/v1/me/instances/inst_local_openai/models'), 200);
      assert.deepStrictEqual(models.bodyJson, {
        results: [{ id: 'fake', name: 'fake', type: 'language' }],
      });
      expectOk(yield* get(api, '/apps/v1/me/instances/inst_other/models'), 404);

      const defaults = expectOk(yield* get(api, '/apps/v1/me/model-defaults'), 200);
      assert.deepStrictEqual(defaults.bodyJson, {
        formatting: { instanceId: 'inst_local_openai', modelId: 'fake' },
        transcription: null,
      });
      const set = expectOk(
        yield* api.request({
          method: 'PUT',
          path: '/apps/v1/me/model-defaults',
          body: { useCase: 'formatting', instanceId: 'inst_local_openai', modelId: 'fake' },
        }),
        200
      );
      assert.deepStrictEqual(set.bodyJson, {
        useCase: 'formatting',
        instanceId: 'inst_local_openai',
        modelId: 'fake',
      });
      const missingModel = expectOk(
        yield* api.request({
          method: 'PUT',
          path: '/apps/v1/me/model-defaults',
          body: { useCase: 'formatting', instanceId: 'inst_local_openai' },
        }),
        422
      );
      assert.strictEqual(missingModel.bodyJson.error.code, 'MODEL_REQUIRED');
      expectOk(yield* api.request({ method: 'DELETE', path: '/apps/v1/me/model-defaults' }), 204);
      yield* Scope.close(scope, Exit.void);
    })
  );
});
