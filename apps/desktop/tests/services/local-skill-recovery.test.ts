import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import { Cause, Context, Effect, Exit, Fiber, Layer, Option, Scope } from 'effect';
import { build } from 'vite';
import * as Y from 'yjs';
import { CLEANUP_SKILL_ID, ENHANCE_SKILL_ID, SUBMIT_OUTPUT_TOOL } from '@prismical/ai-prompts';
import {
  AcceptSkillRunResultSchema,
  PendingSkillResultsSchema,
  RunSkillResultSchema,
  type RunSkillResult,
} from '@prismical/api-contracts/apps/v1';
import { createId } from '@prismical/id';
import { LocalBackendLive } from '../../src/main/domains/local-backend/live';
import { acceptSkillRun } from '../../src/main/domains/local-backend/skills';
import { validateSkillApplication } from '../../src/main/domains/local-backend/skill-application';
import { WorkspaceTransportLive } from '../../src/main/domains/transport/live';
import { WorkspaceBackend } from '../../src/main/domains/transport/service';
import { makeProductDbLayer } from '../../src/main/infra/product-db/live';
import * as schema from '../../src/main/infra/product-db/schema';
import { ProductDb } from '../../src/main/infra/product-db/service';
import { fakeAiProviderLayer } from '../helpers/fake-workspace-env';
import { makeTestLogger, testConfigLayer, testI18nLayer } from '../helpers/test-layers';

const worker = vi.hoisted(() => ({ path: '' }));
vi.mock('../../src/main/domains/local-backend/skill-application', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/main/domains/local-backend/skill-application')>();
  return {
    ...actual,
    validateSkillApplication: (id: string, update: string, workerPath = worker.path) =>
      actual.validateSkillApplication(id, update, workerPath),
  };
});

const tempDir = mkdtempSync(path.join(tmpdir(), 'prismical-durable-skills-'));
const baseContent = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original note.' }] }],
});
const context = () => ({ generationId: randomUUID(), baseContent });
const runPath = `/apps/v1/me/skills/${CLEANUP_SKILL_ID}/run`;
const pendingPath = '/apps/v1/me/skill-runs/pending';
const acceptPath = '/apps/v1/me/skill-runs/accept';
const resolvePath = '/apps/v1/me/skill-runs/resolve';
let sequence = 0;
let output = 'A revised note.';
let model: MockLanguageModelV4;
let harness: Awaited<ReturnType<typeof openBackend>>;

async function openBackend(
  databasePath = path.join(tempDir, `${++sequence}.db`),
  withModel = true
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const env = Layer.mergeAll(
        testConfigLayer({ localDbPath: databasePath }),
        makeTestLogger().layer,
        testI18nLayer(),
        WorkspaceTransportLive,
        fakeAiProviderLayer(withModel ? { model, toolSupport: 'native' } : {})
      );
      const envContext = yield* Layer.build(env).pipe(Scope.provide(scope));
      const productDb = makeProductDbLayer({ kind: 'local' });
      const context = yield* Layer.build(
        Layer.mergeAll(productDb, LocalBackendLive.pipe(Layer.provide(productDb)))
      ).pipe(Effect.provide(envContext), Scope.provide(scope));
      return {
        scope,
        databasePath,
        api: Context.get(context, WorkspaceBackend),
        db: Context.get(context, ProductDb).db,
      };
    })
  );
}

const closeBackend = () => Effect.runPromise(Scope.close(harness.scope, Exit.void));

async function request(
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
  query?: Record<string, string>,
  status = 200
) {
  const result = await Effect.runPromise(harness.api.request({ method, path: route, body, query }));
  expect(result).toMatchObject({ ok: true, status });
  if (!('ok' in result)) throw new Error('Unexpected transport failure');
  return result.bodyJson;
}

function insertNote() {
  const id = createId('note');
  const now = new Date().toISOString();
  harness.db
    .insert(schema.note)
    .values({
      id,
      title: 'Note',
      createdAt: now,
      updatedAt: now,
      metadataUpdatedAt: now,
      contentMarkdown: 'Original note.',
    })
    .run();
  return id;
}

async function run(noteId: string, fields: Record<string, unknown> = {}) {
  return RunSkillResultSchema.parse(
    await request('POST', `${runPath}/durable`, {
      noteId,
      recoverable: true,
      recoveryContext: context(),
      ...fields,
    })
  );
}

async function pending(noteId: string, durable = true) {
  return PendingSkillResultsSchema.parse(
    await request('GET', `${pendingPath}${durable ? '/durable' : ''}`, undefined, { noteId })
  ).results;
}

const acceptBody = (noteId: string, result: RunSkillResult, applicationUpdate?: string) => ({
  noteId,
  resultId: result.resultId,
  skillId: result.skillId,
  recordingId: result.recordingId,
  mode: result.mode,
  content: JSON.stringify([
    { type: 'paragraph', content: [{ type: 'text', text: result.rawMarkdown }] },
  ]),
  prevContent: baseContent,
  rawMarkdown: result.rawMarkdown,
  applicationUpdate,
});

function applicationUpdate(resultId: string, text = 'Applied note.', nodeName = 'paragraph') {
  const doc = new Y.Doc();
  try {
    const paragraph = new Y.XmlElement(nodeName);
    const content = new Y.XmlText();
    content.insert(0, text);
    paragraph.insert(0, [content]);
    doc.getXmlFragment('default').insert(0, [paragraph]);
    doc.getMap('appliedSkillResults').set(resultId, true);
    return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  } finally {
    doc.destroy();
  }
}

beforeAll(async () => {
  worker.path = path.join(tempDir, 'skill-recovery-worker.js');
  // Use the packaging config so tests also prove the worker is self-contained.
  await build({
    configFile: path.resolve(__dirname, '../../vite.skill-recovery-worker.config.mts'),
    logLevel: 'silent',
    root: path.resolve(__dirname, '../..'),
    build: { outDir: tempDir, sourcemap: false },
  });
}, 30_000);

beforeEach(async () => {
  output = 'A revised note.';
  model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: SUBMIT_OUTPUT_TOOL,
          input: JSON.stringify({ markdown: output, reasoning: null }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  harness = await openBackend();
});

afterEach(async () => {
  await closeBackend();
  vi.restoreAllMocks();
  worker.path = path.join(tempDir, 'skill-recovery-worker.js');
});
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe('local durable skill protocol', () => {
  it.each(['replace-doc', 'inline-rewrite'])(
    'recovers %s output and generation context after restart without a provider',
    async mode => {
      const noteId = insertNote();
      const recoveryContext = {
        ...context(),
        selectionText: 'Original',
        selectionAnchors: { relFrom: { item: 1 }, relTo: { item: 2 } },
      };
      const result = await run(noteId, { mode, recoveryContext, selectionText: 'Original' });
      expect(result.recoveryContext).toEqual(recoveryContext);
      expect(result.resultId).toBeTruthy();
      await closeBackend();
      harness = await openBackend(harness.databasePath, false);
      expect(await pending(noteId)).toEqual([result]);
      expect(await pending(noteId, false)).toEqual([]);
      expect(model.doGenerateCalls).toHaveLength(1);
    }
  );

  it('refines inline output under a fresh identity and rejects stale acceptance/refinement', async () => {
    const noteId = insertNote();
    const original = await run(noteId, { mode: 'inline-rewrite', selectionText: 'Original' });
    output = 'Shorter.';
    const refined = await run(noteId, {
      mode: 'inline-rewrite',
      selectionText: 'Original',
      recoveryResultId: original.resultId,
      refineInstruction: 'Shorten',
      previousOutput: original.rawMarkdown,
    });
    expect(refined.resultId).not.toBe(original.resultId);
    expect(await pending(noteId)).toEqual([refined]);
    await request('POST', `${acceptPath}/durable`, acceptBody(noteId, original), undefined, 409);
    await request(
      'POST',
      `${runPath}/durable`,
      {
        noteId,
        recoveryResultId: original.resultId,
        refineInstruction: 'Again',
        previousOutput: original.rawMarkdown,
      },
      undefined,
      409
    );
    await request('POST', `${acceptPath}/durable`, acceptBody(noteId, refined));
    await request(
      'POST',
      `${runPath}/durable`,
      {
        noteId,
        recoveryResultId: refined.resultId,
        refineInstruction: 'Again',
        previousOutput: refined.rawMarkdown,
      },
      undefined,
      409
    );
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('leaves accepted output pending until canonical application delivery is resolved', async () => {
    const noteId = insertNote();
    const result = await run(noteId);
    const body = acceptBody(noteId, result);
    const receipt = AcceptSkillRunResultSchema.parse(
      await request('POST', `${acceptPath}/durable`, body)
    );
    expect(await pending(noteId)).toEqual([
      { ...result, acceptance: { result: receipt, prevContent: baseContent } },
    ]);
    const update = applicationUpdate(result.resultId!);
    const prepared = AcceptSkillRunResultSchema.parse(
      await request('POST', `${acceptPath}/durable`, { ...body, applicationUpdate: update })
    );
    expect(prepared).toEqual({ ...receipt, applicationUpdate: update });
    await closeBackend();
    harness = await openBackend(harness.databasePath, false);
    expect(await pending(noteId)).toEqual([
      { ...result, acceptance: { result: prepared, prevContent: baseContent } },
    ]);
    await request(
      'POST',
      `${resolvePath}/durable`,
      { noteId, resultId: result.resultId, discardAccepted: true },
      undefined,
      409
    );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(prepared.applicationUpdate!, 'base64'));
    expect(doc.getMap('appliedSkillResults').get(result.resultId!)).toBe(true);
    doc.destroy();
    await request('POST', `${resolvePath}/durable`, { noteId, resultId: result.resultId });
    expect(await pending(noteId)).toEqual([]);
    expect(await request('POST', `${acceptPath}/durable`, body)).toEqual(prepared);
    expect(harness.db.select().from(schema.artifact).all()).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it('refreshes a recording receipt after restart when the client omits recordingId', async () => {
    const noteId = insertNote();
    const recordingId = createId('recording');
    const now = new Date().toISOString();
    harness.db
      .insert(schema.recording)
      .values({
        id: recordingId,
        noteId,
        title: 'Recording',
        captureMode: 'mic',
        status: 'completed',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    harness.db
      .insert(schema.transcriptSegment)
      .values({
        id: createId('transcriptSegment'),
        recordingId,
        source: 'mic',
        speaker: 'you',
        text: 'A useful transcript.',
        startTimeMs: 0,
        endTimeMs: 1000,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const result = RunSkillResultSchema.parse(
      await request('POST', `/apps/v1/me/skills/${ENHANCE_SKILL_ID}/run/durable`, {
        noteId,
        recordingId,
        recoverable: true,
        recoveryContext: context(),
      })
    );
    expect(result.recordingId).toBe(recordingId);
    const body = acceptBody(noteId, result);
    const receipt = await request('POST', `${acceptPath}/durable`, body);
    await closeBackend();
    harness = await openBackend(harness.databasePath, false);
    expect(await pending(noteId)).toHaveLength(1);
    const refreshBody = { ...body, recordingId: undefined };
    expect(await request('POST', `${acceptPath}/durable`, refreshBody)).toEqual(receipt);
    const update = applicationUpdate(result.resultId!);
    const prepared = await request('POST', `${acceptPath}/durable`, {
      ...refreshBody,
      applicationUpdate: update,
    });
    expect(prepared).toEqual({
      ...AcceptSkillRunResultSchema.parse(receipt),
      applicationUpdate: update,
    });
    await request('POST', `${resolvePath}/durable`, { noteId, resultId: result.resultId });
    expect(await pending(noteId)).toEqual([]);
    expect(harness.db.select().from(schema.artifact).all()).toHaveLength(1);
  });

  it('validates the marker and document schema, and keeps the first canonical update across windows', async () => {
    const noteId = insertNote();
    const result = await run(noteId);
    const body = acceptBody(noteId, result);
    await request('POST', `${acceptPath}/durable`, body);
    for (const update of [
      'AAAA',
      applicationUpdate('another_result'),
      applicationUpdate(result.resultId!, 'bad', 'unknownSchemaNode'),
    ]) {
      await request(
        'POST',
        `${acceptPath}/durable`,
        { ...body, applicationUpdate: update },
        undefined,
        409
      );
    }
    const updates = [
      applicationUpdate(result.resultId!, 'First window'),
      applicationUpdate(result.resultId!, 'Second window'),
    ];
    const receipts = await Promise.all(
      updates.map(update =>
        request('POST', `${acceptPath}/durable`, { ...body, applicationUpdate: update })
      )
    );
    expect(receipts[0]).toEqual(receipts[1]);
    expect(updates).toContain(AcceptSkillRunResultSchema.parse(receipts[0]).applicationUpdate);
    expect(harness.db.select().from(schema.artifact).all()).toHaveLength(1);
  });

  it('rechecks state after validation so discard cannot resurrect a receipt', async () => {
    const noteId = insertNote();
    const result = await run(noteId);
    const body = acceptBody(noteId, result);
    await request('POST', `${acceptPath}/durable`, body);
    let release!: (valid: boolean) => void;
    const validating = acceptSkillRun(
      harness.db,
      { ...body, applicationUpdate: applicationUpdate(result.resultId!) },
      true,
      () =>
        new Promise<boolean>(resolve => {
          release = resolve;
        })
    );
    await request('POST', `${resolvePath}/durable`, {
      noteId,
      resultId: result.resultId,
      discardAccepted: true,
    });
    release(true);
    expect((await validating).status).toBe(409);
    expect(harness.db.select().from(schema.artifact).all()[0].deletedAt).not.toBeNull();
  });

  it('keeps legacy results readable while legacy mutation routes cannot touch durable results', async () => {
    const noteId = insertNote();
    const durable = await run(noteId);
    await request(
      'POST',
      runPath,
      { noteId, recoverable: true, recoveryContext: context() },
      undefined,
      409
    );
    await request(
      'POST',
      runPath,
      {
        noteId,
        recoveryResultId: durable.resultId,
        refineInstruction: 'Shorten',
        previousOutput: durable.rawMarkdown,
      },
      undefined,
      409
    );
    await request('POST', acceptPath, acceptBody(noteId, durable), undefined, 409);
    await request('POST', resolvePath, { noteId, resultId: durable.resultId }, undefined, 409);
    const legacy = RunSkillResultSchema.parse(
      await request('POST', runPath, { noteId, recoverable: true })
    );
    expect(await pending(noteId, false)).toEqual([legacy]);
    expect(await pending(noteId)).toHaveLength(2);
    await request('POST', acceptPath, acceptBody(noteId, legacy));
    expect(await pending(noteId)).toEqual([durable]);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('keeps retained receipt-only runs out of pending review', async () => {
    const noteId = insertNote();
    const result = await run(noteId, { recoverable: false, retainResult: true });
    expect(result.resultId).toBeTruthy();
    expect(await pending(noteId)).toEqual([]);
    await request('POST', `${acceptPath}/durable`, acceptBody(noteId, result));
    await request('POST', `${resolvePath}/durable`, {
      noteId,
      resultId: result.resultId,
      discardAccepted: true,
    });
    expect(harness.db.select().from(schema.artifact).all()[0].deletedAt).not.toBeNull();
  });

  it('does not start validation after the workspace closes', async () => {
    const noteId = insertNote();
    const result = await run(noteId);
    await request('POST', `${acceptPath}/durable`, acceptBody(noteId, result));
    await closeBackend();
    const response = await Effect.runPromise(
      harness.api.request({
        method: 'POST',
        path: `${acceptPath}/durable`,
        body: acceptBody(noteId, result, applicationUpdate(result.resultId!)),
      })
    );
    expect(response).toEqual({ error: { code: 'INTERNAL' } });
  });

  it('joins validation on workspace close and leaves the receipt recoverable after restart', async () => {
    const noteId = insertNote();
    const result = await run(noteId);
    const body = acceptBody(noteId, result);
    const receipt = await request('POST', `${acceptPath}/durable`, body);
    worker.path = waitingWorker();
    const termination = vi.spyOn(Worker.prototype, 'terminate');
    const requestResult = Effect.runPromise(
      harness.api.request({
        method: 'POST',
        path: `${acceptPath}/durable`,
        body: { ...body, applicationUpdate: applicationUpdate(result.resultId!) },
      })
    );
    await Effect.runPromise(Effect.sleep('20 millis'));
    await closeBackend();
    expect(await requestResult).toEqual({ error: { code: 'INTERNAL' } });
    expect(termination).toHaveBeenCalledOnce();
    expect(termination.mock.contexts[0]).toMatchObject({ threadId: -1 });
    harness = await openBackend(harness.databasePath, false);
    expect(await pending(noteId)).toEqual([
      { ...result, acceptance: { result: receipt, prevContent: baseContent } },
    ]);
  });
});

function waitingWorker() {
  const workerPath = path.join(tempDir, 'waiting-worker.cjs');
  writeFileSync(workerPath, "require('node:worker_threads').parentPort.on('message', () => {});");
  return workerPath;
}

describe('skill validation worker ownership', () => {
  it('interrupts and joins a worker before returning', async () => {
    const termination = vi.spyOn(Worker.prototype, 'terminate');
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          validateSkillApplication('id', 'AAAA', waitingWorker())
        );
        yield* Effect.sleep('20 millis');
        yield* Fiber.interrupt(fiber);
        expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      })
    );
    expect(termination).toHaveBeenCalledOnce();
    expect(termination.mock.contexts[0]).toMatchObject({ threadId: -1 });
  });

  it('terminates a worker that exceeds the validation deadline', async () => {
    const termination = vi.spyOn(Worker.prototype, 'terminate');
    const exit = await Effect.runPromise(
      Effect.exit(validateSkillApplication('id', 'AAAA', waitingWorker()))
    );
    if (!Exit.isFailure(exit)) throw new Error('Expected validation timeout');
    expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
      _tag: 'TimeoutError',
    });
    expect(termination).toHaveBeenCalledOnce();
    expect(termination.mock.contexts[0]).toMatchObject({ threadId: -1 });
  }, 10_000);
});
