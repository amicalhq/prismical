import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { RecordingSpeakerResponseSchema } from '@prismical/api-contracts/apps/v1';
import { LOCAL_WORKSPACE } from '@prismical/desktop-contracts';
import { applyProductMigrations, MIGRATIONS } from '../../src/main/infra/product-db/migrations';
import * as schema from '../../src/main/infra/product-db/schema';
import {
  listRecordingSpeakers,
  loadSpeakerLabeler,
  renameRecordingSpeaker,
  speakerCandidates,
  tagRecordingSpeaker,
} from '../../src/main/domains/local-backend/speakers';
import { loadNoteInput } from '../../src/main/domains/local-backend/note-input';
import { getNoteForAsk } from '../../src/main/domains/local-backend/ask';
import {
  handleLocalRequest,
  type LocalRouteContext,
} from '../../src/main/domains/local-backend/router';
import {
  LOCAL_SYNC_ENTITIES,
  updateEntity,
} from '../../src/main/domains/local-backend/sync-entities';
import type { LocalDb, RouteResult } from '../../src/main/domains/local-backend/wire';

const stamp = '2026-09-15T00:00:00.000Z';
let client: Database.Database;
let db: LocalDb;
const rowOf = (result: RouteResult) => {
  expect(result.status).toBe(200);
  return RecordingSpeakerResponseSchema.parse(result.body);
};
const tag = (key: string, patch: unknown, recordingId = 'rec_a') =>
  tagRecordingSpeaker(db, recordingId, key, patch);
const seed = () => {
  db.insert(schema.note)
    .values({
      id: 'nt_a',
      title: 'Notes',
      contentMarkdown: 'Body',
      createdAt: stamp,
      updatedAt: stamp,
      metadataUpdatedAt: stamp,
    })
    .run();
  db.insert(schema.recording)
    .values(
      ['rec_a', 'rec_b'].map(id => ({
        id,
        title: id,
        noteId: 'nt_a',
        captureMode: 'dual' as const,
        status: 'completed' as const,
        createdAt: stamp,
        updatedAt: stamp,
      }))
    )
    .run();
};

beforeEach(() => {
  client = new Database(':memory:');
  applyProductMigrations(client);
  db = drizzle(client, { schema });
  seed();
});
afterEach(() => client.close());

describe('local speaker identity', () => {
  it('serves the shared list, keyed tag, legacy rename and candidates HTTP shapes', async () => {
    const unused = async (): Promise<never> => {
      throw new Error('Speaker routes must not call AI');
    };
    const ctx: LocalRouteContext = {
      db,
      client,
      locale: 'en-US',
      log: () => {},
      recoverableRuns: new Map(),
      titleLock: work => work(),
      validateSkillApplication: unused,
      ai: {
        resolve: unused,
        instances: unused,
        listModels: unused,
        defaultSelection: unused,
        setDefault: unused,
        rememberToolSupport: unused,
      },
    };
    const tagged = rowOf(
      await handleLocalRequest(ctx, {
        method: 'PUT',
        path: '/apps/v1/me/recordings/rec_a/speakers/dz%3A2',
        body: { displayName: 'Pat' },
      })
    );
    expect(
      await handleLocalRequest(ctx, {
        method: 'GET',
        path: '/apps/v1/me/recording-speakers',
        query: { recordingId: 'rec_a' },
      })
    ).toEqual({ status: 200, body: { results: [tagged] } });
    expect(
      rowOf(
        await handleLocalRequest(ctx, {
          method: 'PATCH',
          path: `/apps/v1/me/recording-speakers/${tagged.id}`,
          body: { displayName: 'Taylor' },
        })
      ).displayName
    ).toBe('Taylor');
    expect(
      await handleLocalRequest(ctx, {
        method: 'GET',
        path: '/apps/v1/me/recordings/rec_a/speaker-candidates',
      })
    ).toEqual({ status: 200, body: { participants: [] } });
  });

  it('upserts channel and encoded diarized keys before any registry exists, with stable IDs', () => {
    const you = rowOf(tag('you', { displayName: 'My voice' }));
    expect(you.isOwner).toBe(true);
    expect(you.orgUserId).toBe(LOCAL_WORKSPACE.orgUserId);
    expect(you.id).toMatch(/^rsp_/);
    expect(rowOf(tag('them', { displayName: 'Guest' })).isOwner).toBe(false);
    const diarized = rowOf(tag('dz%3A2', { displayName: 'Pat' }));
    expect(diarized.speakerKey).toBe('dz:2');
    const renamed = rowOf(renameRecordingSpeaker(db, diarized.id, { displayName: 'Taylor' }));
    expect(renamed.id).toBe(diarized.id);
    expect(renamed.displayName).toBe('Taylor');
    expect(renamed.updatedAt > diarized.updatedAt).toBe(true);
    expect(rowOf(tag('dz:2', { displayName: null, personId: null })).displayName).toBeNull();
  });

  it('moves the owner atomically, preserves names and emits changed rows after a strict cursor', () => {
    const first = rowOf(tag('you', { displayName: 'Original owner' }));
    rowOf(tag('dz:0', { displayName: 'Selected voice', isOwner: true }));
    rowOf(tag('them', { isOwner: true }));
    const rows = db.select().from(schema.recordingSpeaker).all();
    expect(rows.filter(row => row.isOwner).map(row => row.speakerKey)).toEqual(['them']);
    expect(rows.find(row => row.speakerKey === 'you')).toMatchObject({
      displayName: 'Original owner',
      source: 'user',
      isOwner: false,
    });
    const delta = listRecordingSpeakers(db, { recordingId: 'rec_a', since: first.updatedAt });
    expect(delta).toMatchObject({
      status: 200,
      body: {
        results: expect.arrayContaining([
          expect.objectContaining({ speakerKey: 'you', isOwner: false }),
          expect.objectContaining({ speakerKey: 'them', isOwner: true }),
        ]),
      },
    });
    expect(() =>
      db
        .insert(schema.recordingSpeaker)
        .values({
          id: 'rsp_duplicate',
          recordingId: 'rec_a',
          speakerKey: 'dz:9',
          source: 'user',
          isOwner: true,
          createdAt: stamp,
          updatedAt: stamp,
        })
        .run()
    ).toThrow();
  });

  it('does not reclaim the owner on rename/reset after Not me or another owner choice', () => {
    rowOf(tag('you', { isOwner: false }));
    expect(rowOf(tag('you', { displayName: 'Guest mic' })).isOwner).toBe(false);
    rowOf(tag('them', { isOwner: true }));
    expect(rowOf(tag('you', { displayName: null })).isOwner).toBe(false);
    // Also handle older/incomplete registries where the other owner has no mic sentinel.
    db.delete(schema.recordingSpeaker).where(eq(schema.recordingSpeaker.speakerKey, 'you')).run();
    expect(rowOf(tag('you', { displayName: 'Guest mic' })).isOwner).toBe(false);
    expect(loadSpeakerLabeler(db, ['rec_a'])('rec_a', 'them')).toBe('You');
  });

  it('rejects invalid keys, patches, foreign people and deleted recordings without changing identity', () => {
    for (const key of ['bad', 'dz:', 'dz:with/slash', '%zz'])
      expect(tag(key, { isOwner: true }).status).toBe(400);
    for (const patch of [
      {},
      { displayName: '' },
      { isOwner: 'true' },
      { displayName: 'x'.repeat(121) },
    ]) {
      expect(tag('them', patch).status).toBe(400);
    }
    expect(tag('them', { personId: 'prs_cloud', isOwner: true }).status).toBe(404);
    expect(tag('them', { isOwner: false }).status).toBe(404);
    expect(tag('them', { displayName: 'No record' }, 'rec_missing').status).toBe(404);
    rowOf(tag('you', { isOwner: true }));
    db.update(schema.recording)
      .set({ deletedAt: stamp })
      .where(eq(schema.recording.id, 'rec_a'))
      .run();
    expect(tag('them', { isOwner: true }).status).toBe(404);
    expect(listRecordingSpeakers(db, {})).toEqual({ status: 200, body: { results: [] } });
    expect(speakerCandidates(db, 'rec_a').status).toBe(404);
    expect(speakerCandidates(db, 'rec_b')).toEqual({ status: 200, body: { participants: [] } });
  });

  it('keeps user tags after recording completion and labels Enhance and Ask by recording', async () => {
    rowOf(tag('them', { displayName: 'Pat' }));
    rowOf(tag('you', { isOwner: false }));
    rowOf(tag('them', { isOwner: true }, 'rec_b'));
    const recordingEntity = LOCAL_SYNC_ENTITIES.find(entity => entity.route === 'recordings')!;
    expect(
      (
        await updateEntity(db, recordingEntity, 'rec_a', {
          status: 'completed',
          endedAt: Date.now(),
        })
      ).status
    ).toBe(200);
    db.insert(schema.transcriptSegment)
      .values(
        [
          { recordingId: 'rec_a', speaker: 'you' as const, text: 'not owner' },
          { recordingId: 'rec_a', speaker: 'them' as const, text: 'guest text' },
          { recordingId: 'rec_b', speaker: 'them' as const, text: 'owner text' },
        ].map((segment, i) => ({
          ...segment,
          id: `tsg_${i}`,
          source: 'mic' as const,
          startTimeMs: i * 1000,
          endTimeMs: i * 1000 + 500,
          segmentOrder: i,
          createdAt: stamp,
          updatedAt: stamp,
        }))
      )
      .run();
    expect((await loadNoteInput(db, 'nt_a', { includeTranscript: true }))?.transcript).toBe(
      'Them: not owner\nPat: guest text\nYou: owner text'
    );
    expect(await getNoteForAsk(db, 'nt_a')).toMatchObject({
      content: expect.stringContaining('Pat: guest text'),
    });
    expect(await getNoteForAsk(db, 'nt_a')).toMatchObject({
      content: expect.stringContaining('You: owner text'),
    });
    expect(loadSpeakerLabeler(db, [])('rec_missing', 'dz:2')).toBe('Speaker 3');
  });

  it('migrates an existing store and preserves tags across reopen with workspace isolation', () => {
    client.close();
    const directory = mkdtempSync(path.join(tmpdir(), 'prismical-speakers-'));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'local.db');
    client = new Database(filename);
    for (const migration of MIGRATIONS.filter(m => m.version <= 3)) {
      client.exec(migration.sql);
      client
        .prepare('INSERT INTO schema_meta (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, stamp);
    }
    expect(applyProductMigrations(client)).toEqual([4]);
    db = drizzle(client, { schema });
    seed();
    const tagged = rowOf(tag('them', { displayName: 'Persistent name', isOwner: true }));
    client.close();
    client = new Database(filename);
    expect(applyProductMigrations(client)).toEqual([]);
    db = drizzle(client, { schema });
    expect(
      db
        .select()
        .from(schema.recordingSpeaker)
        .where(eq(schema.recordingSpeaker.id, tagged.id))
        .get()
    ).toMatchObject({ displayName: 'Persistent name', isOwner: true });
    const other = new Database(':memory:');
    try {
      applyProductMigrations(other);
      expect(listRecordingSpeakers(drizzle(other, { schema }), {})).toEqual({
        status: 200,
        body: { results: [] },
      });
    } finally {
      other.close();
    }
  });
});
