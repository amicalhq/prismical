import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createId } from '@prismical/id';
import { UserPreferencesSchema } from '@prismical/api-contracts/apps/v1';
import { applyProductMigrations } from '../../src/main/infra/product-db/migrations';
import * as schema from '../../src/main/infra/product-db/schema';
import {
  getLocalPreferences,
  writeLocalPreferences,
} from '../../src/main/domains/local-backend/preferences';
import {
  LOCAL_SYNC_ENTITIES,
  listEntity,
  removeEntity,
  updateEntity,
  upsertEntity,
} from '../../src/main/domains/local-backend/sync-entities';
import { createNote, listNotes, updateNote } from '../../src/main/domains/local-backend/notes';
import { loadNoteInput } from '../../src/main/domains/local-backend/note-input';
import type { LocalDb } from '../../src/main/domains/local-backend/wire';
import { migrateLocalPreferences } from '../../src/renderer/main/app/settings/local-preference-migration';

const NOW = '2026-09-15T12:00:00.000Z';
const OLD = '2026-09-14T12:00:00.000Z';
const FUTURE = '2026-09-16T12:00:00.000Z';
const folders = LOCAL_SYNC_ENTITIES.find(entity => entity.route === 'folders')!;
let directory: string;
let dbPath: string;
let client: Database.Database;
let db: LocalDb;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  directory = mkdtempSync(path.join(tmpdir(), 'prismical-local-alignment-'));
  dbPath = path.join(directory, 'local.db');
  client = new Database(dbPath);
  applyProductMigrations(client);
  db = drizzle(client, { schema });
});

afterEach(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

const folderRow = (id: string) =>
  db.select().from(schema.folder).where(eq(schema.folder.id, id)).get()!;
const noteRow = (id: string) => db.select().from(schema.note).where(eq(schema.note.id, id)).get()!;

async function addFolder(parentId: string | null = null, updatedAt = OLD): Promise<string> {
  const id = createId('folder');
  expect((await upsertEntity(db, folders, { id, name: id, parentId, updatedAt })).status).toBe(201);
  return id;
}

async function addNote(folderId: string | null = null, updatedAt = OLD): Promise<string> {
  const id = createId('note');
  expect((await createNote(db, { id, title: 'Saved note', folderId, updatedAt })).status).toBe(201);
  return id;
}

describe('local account experience preferences', () => {
  it('legacy renderer POST migration preserves groups already saved in the local database', async () => {
    writeLocalPreferences(db, 'PATCH', {
      experience: { autoEnhance: false, theme: 'dark' },
      ask: { 'local-org': { instanceId: 'saved', modelId: 'saved-model' } },
    });
    const before = getLocalPreferences(db);
    const legacy: Record<string, string> = {
      'prismical:auto-enhance': '1',
      theme: 'light',
      'ask.model.v1': JSON.stringify({ instanceId: 'old', modelId: 'old-model' }),
    };
    await migrateLocalPreferences({
      appMode: 'local',
      getStorage: () => ({ getItem: key => legacy[key] ?? null, setItem: () => {} }),
      request: async request => {
        expect(request.method).toBe('POST');
        const result = writeLocalPreferences(db, 'POST', request.body);
        return { ok: true, status: result.status, bodyJson: result.body };
      },
    });
    expect(getLocalPreferences(db)).toEqual(before);
  });

  it('reads all six groups without seeding and persists partial groups across reopen', () => {
    expect(getLocalPreferences(db)).toEqual({
      language: null,
      transcription: null,
      experience: null,
      ask: null,
      onboarding: null,
      prompts: null,
    });
    expect(db.select().from(schema.userPreference).all()).toEqual([]);
    const result = writeLocalPreferences(db, 'PATCH', {
      language: { interfaceLanguage: 'de' },
      transcription: { language: 'ja' },
      experience: { autoEnhance: false },
      ask: { org_a: { instanceId: 'local-ai', modelId: 'model-a' } },
      onboarding: {
        walkthrough: { status: 'active', orgId: 'org_a', noteId: 'nt_a', step: 'speak' },
      },
      prompts: { getAppsSeen: true },
    });
    expect(result.status).toBe(200);
    expect(UserPreferencesSchema.parse(result.body)).toMatchObject({
      language: { interfaceLanguage: 'de' },
      transcription: { language: 'ja' },
      experience: { autoEnhance: false, autoTranscribeNewNotes: false, theme: 'system' },
      ask: { org_a: { instanceId: 'local-ai', modelId: 'model-a' } },
      onboarding: { walkthrough: { status: 'active', step: 'speak' }, replayRetired: false },
      prompts: { getAppsSeen: true, calendarDismissed: false },
    });
    client.close();
    client = new Database(dbPath);
    db = drizzle(client, { schema });
    expect(getLocalPreferences(db)).toEqual(result.body);
  });

  it('initializes missing/null groups once and retains unrelated saved data', () => {
    db.insert(schema.userPreference)
      .values({
        id: 1,
        prefs: {
          legacyDictation: { enabled: true },
          experience: { autoEnhance: false, theme: 'dark', autoTranscribeNewNotes: true },
          prompts: null,
        },
      })
      .run();
    expect(
      writeLocalPreferences(db, 'POST', {
        experience: { autoEnhance: true, theme: 'light' },
        prompts: { calendarDismissed: true },
        ask: {},
      }).status
    ).toBe(200);
    expect(
      writeLocalPreferences(db, 'POST', {
        prompts: { calendarDismissed: false },
        ask: {
          org_a: { instanceId: 'ignored', modelId: 'ignored' },
        },
      }).status
    ).toBe(200);
    expect(getLocalPreferences(db)).toMatchObject({
      experience: { autoEnhance: false, theme: 'dark', autoTranscribeNewNotes: true },
      prompts: { getAppsSeen: false, calendarDismissed: true },
      ask: {},
    });
    expect(db.select().from(schema.userPreference).get()!.prefs.legacyDictation).toEqual({
      enabled: true,
    });
  });

  it('merges partial edits from separate connections without replacing another org selection', async () => {
    const peer = new Database(dbPath);
    try {
      const peerDb = drizzle(peer, { schema });
      const results = await Promise.all([
        Promise.resolve().then(() =>
          writeLocalPreferences(db, 'PATCH', {
            experience: { autoEnhance: false },
            ask: { org_a: { instanceId: 'a', modelId: 'model-a' } },
          })
        ),
        Promise.resolve().then(() =>
          writeLocalPreferences(peerDb, 'PATCH', {
            experience: { theme: 'dark' },
            ask: { org_b: { instanceId: 'b', modelId: 'model-b' } },
          })
        ),
      ]);
      expect(results.map(result => result.status)).toEqual([200, 200]);
      expect(getLocalPreferences(db)).toMatchObject({
        experience: { autoEnhance: false, theme: 'dark' },
        ask: {
          org_a: { instanceId: 'a', modelId: 'model-a' },
          org_b: { instanceId: 'b', modelId: 'model-b' },
        },
      });
    } finally {
      peer.close();
    }
  });

  it('keeps prompt acknowledgments and replay retirement after stale false patches', () => {
    writeLocalPreferences(db, 'PATCH', {
      prompts: { getAppsSeen: true, calendarDismissed: true },
      onboarding: { replayRetired: true },
    });
    writeLocalPreferences(db, 'PATCH', {
      prompts: { getAppsSeen: false, calendarDismissed: false },
      onboarding: { replayRetired: false },
    });
    expect(getLocalPreferences(db)).toMatchObject({
      prompts: { getAppsSeen: true, calendarDismissed: true },
      onboarding: { replayRetired: true },
    });
  });

  it.each(['dismissed', 'completed'] as const)(
    'preserves %s walkthroughs until explicit replay; completion wins',
    status => {
      writeLocalPreferences(db, 'PATCH', { onboarding: { walkthrough: { status } } });
      for (const walkthrough of [
        null,
        { status: 'offered' },
        { status: 'active', orgId: 'o', noteId: 'n', step: 'record' },
      ]) {
        expect(writeLocalPreferences(db, 'PATCH', { onboarding: { walkthrough } }).status).toBe(
          200
        );
        expect(getLocalPreferences(db).onboarding?.walkthrough).toEqual({ status });
      }
      writeLocalPreferences(db, 'PATCH', { onboarding: { walkthrough: { status: 'completed' } } });
      writeLocalPreferences(db, 'PATCH', { onboarding: { walkthrough: { status: 'dismissed' } } });
      expect(getLocalPreferences(db).onboarding?.walkthrough).toEqual({ status: 'completed' });
      writeLocalPreferences(db, 'PATCH', {
        onboarding: { walkthrough: { status: 'offered', replay: true } },
      });
      expect(getLocalPreferences(db).onboarding?.walkthrough).toEqual({
        status: 'offered',
        replay: true,
      });
      writeLocalPreferences(db, 'PATCH', {
        onboarding: { walkthrough: { status: 'completed' }, replayRetired: true },
      });
      writeLocalPreferences(db, 'PATCH', {
        onboarding: { walkthrough: { status: 'offered', replay: true } },
      });
      expect(getLocalPreferences(db).onboarding).toMatchObject({
        walkthrough: { status: 'offered', replay: true },
        replayRetired: true,
      });
    }
  );

  it.each([
    { ask: {} },
    { experience: {} },
    { experience: { theme: undefined } },
    { prompts: { unknown: true } },
  ])('rejects invalid partial patches without storing a row: %j', patch => {
    expect(writeLocalPreferences(db, 'PATCH', patch).status).toBe(400);
    expect(db.select().from(schema.userPreference).all()).toEqual([]);
  });
});

describe('local recording capture context', () => {
  it('uses the requested recording language without borrowing the latest recording language', async () => {
    const noteId = await addNote();
    db.insert(schema.recording)
      .values([
        {
          id: 'rec_selected',
          title: 'Selected recording',
          noteId,
          captureMode: 'mic',
          transcriptionConfig: { language: 'ja' },
          startedAt: OLD,
          createdAt: OLD,
          updatedAt: OLD,
        },
        {
          id: 'rec_latest',
          title: 'Latest recording',
          noteId,
          captureMode: 'dual',
          transcriptionConfig: { language: 'en' },
          startedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ])
      .run();
    expect(
      await loadNoteInput(db, noteId, { includeTranscript: true, recordingId: 'rec_selected' })
    ).toMatchObject({ context: { captureMode: 'mic', spokenLanguage: 'ja' } });
    const unscoped = await loadNoteInput(db, noteId, { includeTranscript: true });
    expect(unscoped?.context).toMatchObject({ captureMode: 'dual' });
    expect(unscoped?.context).not.toHaveProperty('spokenLanguage');
    expect(
      (await loadNoteInput(db, noteId, { includeTranscript: false, recordingId: 'rec_selected' }))
        ?.context
    ).toBeUndefined();
  });

  it.each([null, {}, { language: '' }, { language: 42 }])(
    'does not invent a capture language for transcription config %j',
    async transcriptionConfig => {
      const noteId = await addNote();
      db.insert(schema.recording)
        .values({
          id: 'rec_no_language',
          title: 'Recording',
          noteId,
          captureMode: 'mic',
          transcriptionConfig,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
      const input = await loadNoteInput(db, noteId, {
        includeTranscript: true,
        recordingId: 'rec_no_language',
      });
      expect(input?.context).not.toHaveProperty('spokenLanguage');
    }
  );
});

describe('local folder hierarchy', () => {
  it('creates nested folders, moves them, and rejects absent/deleted/self/descendant parents', async () => {
    const parent = await addFolder();
    const child = await addFolder(parent);
    const grandchild = await addFolder(child);
    const deleted = await addFolder();
    await removeEntity(db, folders, deleted);
    for (const parentId of [createId('folder'), deleted, parent, grandchild]) {
      expect((await updateEntity(db, folders, parent, { parentId, updatedAt: NOW })).status).toBe(
        404
      );
      expect(folderRow(parent).parentId).toBeNull();
    }
    const self = createId('folder');
    expect(
      (await upsertEntity(db, folders, { id: self, name: 'self', parentId: self })).status
    ).toBe(404);
    expect(
      (await upsertEntity(db, folders, { name: 'missing', parentId: createId('folder') })).status
    ).toBe(404);
    expect((await upsertEntity(db, folders, { name: 'deleted', parentId: deleted })).status).toBe(
      404
    );
    expect(
      (await updateEntity(db, folders, child, { parentId: null, updatedAt: NOW })).status
    ).toBe(200);
    expect(folderRow(child).parentId).toBeNull();
    expect(folderRow(grandchild).parentId).toBe(child);
  });

  it('prevents cycles through tombstones and concurrent opposing moves', async () => {
    const a = await addFolder();
    const b = await addFolder(a);
    const c = await addFolder(b);
    db.update(schema.folder).set({ deletedAt: NOW }).where(eq(schema.folder.id, b)).run();
    expect((await updateEntity(db, folders, a, { parentId: c, updatedAt: NOW })).status).toBe(404);
    const d = await addFolder();
    const results = await Promise.all([
      updateEntity(db, folders, a, { parentId: d, updatedAt: NOW }),
      updateEntity(db, folders, d, { parentId: a, updatedAt: NOW }),
    ]);
    expect(results.map(result => result.status)).toEqual([200, 404]);
    expect(folderRow(a).parentId).toBe(d);
    expect(folderRow(d).parentId).toBeNull();
  });

  it('detaches immediate children and all notes with monotonic clocks, including trashed/deleted rows', async () => {
    const parent = await addFolder(null, FUTURE);
    const child = await addFolder(parent, FUTURE);
    const grandchild = await addFolder(child);
    const ids = await Promise.all([addNote(parent), addNote(parent), addNote(parent)]);
    db.update(schema.note).set({ updatedAt: FUTURE, metadataUpdatedAt: FUTURE }).run();
    db.update(schema.note).set({ trashedAt: OLD }).where(eq(schema.note.id, ids[1]!)).run();
    db.update(schema.note).set({ deletedAt: OLD }).where(eq(schema.note.id, ids[2]!)).run();
    expect((await removeEntity(db, folders, parent)).status).toBe(204);
    expect(folderRow(parent)).toMatchObject({
      deletedAt: NOW,
      updatedAt: '2026-09-16T12:00:00.001Z',
    });
    expect(folderRow(child)).toMatchObject({
      parentId: null,
      updatedAt: '2026-09-16T12:00:00.001Z',
    });
    expect(folderRow(grandchild).parentId).toBe(child);
    for (const id of ids) {
      expect(noteRow(id)).toMatchObject({
        folderId: null,
        updatedAt: '2026-09-16T12:00:00.001Z',
        metadataUpdatedAt: '2026-09-16T12:00:00.001Z',
      });
    }
    expect(noteRow(ids[0]!).deletedAt).toBeNull();
    expect(noteRow(ids[1]!).trashedAt).toBe(OLD);
    expect(noteRow(ids[2]!).deletedAt).toBe(OLD);
    const delta = await listNotes(db, { since: FUTURE, includeDeleted: '1' });
    expect((delta.body as { results: { id: string }[] }).results.map(row => row.id).sort()).toEqual(
      [...ids].sort()
    );
    const folderDelta = await listEntity(db, folders, { since: FUTURE, includeDeleted: '1' });
    expect(
      (folderDelta.body as { results: { id: string }[] }).results.map(row => row.id).sort()
    ).toEqual([parent, child].sort());
    expect((await removeEntity(db, folders, parent)).status).toBe(404);
  });

  it('rolls back the parent tombstone and note detach if detaching a child fails', async () => {
    const parent = await addFolder();
    const child = await addFolder(parent);
    const note = await addNote(parent);
    const before = { parent: folderRow(parent), child: folderRow(child), note: noteRow(note) };
    client.exec(
      "CREATE TRIGGER block_detach BEFORE UPDATE OF parent_id ON folder BEGIN SELECT RAISE(ABORT, 'blocked detach'); END"
    );
    await expect(removeEntity(db, folders, parent)).rejects.toThrow();
    expect({ parent: folderRow(parent), child: folderRow(child), note: noteRow(note) }).toEqual(
      before
    );
  });

  it('cannot leave dangling note assignments when a folder deletion races a create or move', async () => {
    const parent = await addFolder();
    const id = createId('note');
    const results = await Promise.all([
      createNote(db, { id, folderId: parent, updatedAt: OLD }),
      removeEntity(db, folders, parent),
    ]);
    expect(results.map(result => result.status)).toEqual([201, 204]);
    expect(noteRow(id).folderId).toBeNull();
    expect((await updateNote(db, id, { folderId: parent, updatedAt: FUTURE })).status).toBe(404);
    expect((await createNote(db, { folderId: parent })).status).toBe(404);
    const target = await addFolder();
    const moving = await Promise.all([
      updateNote(db, id, { folderId: target, updatedAt: FUTURE }),
      removeEntity(db, folders, target),
    ]);
    expect(moving.map(result => result.status)).toEqual([200, 204]);
    expect(noteRow(id).folderId).toBeNull();
  });
});

describe('local delayed note creation', () => {
  it('publishes delayed creates beyond another window cursor while retaining the client conflict clock', async () => {
    const cursor = '2026-09-15T11:00:00.000Z';
    const id = await addNote(null, OLD);
    expect(noteRow(id)).toMatchObject({ updatedAt: NOW, metadataUpdatedAt: OLD });
    const delta = await listNotes(db, { since: cursor });
    expect((delta.body as { results: { id: string }[] }).results.map(row => row.id)).toEqual([id]);
    expect((await createNote(db, { id, title: 'Saved note', updatedAt: OLD })).status).toBe(200);
    expect(db.select().from(schema.note).all()).toHaveLength(1);
    const stale = await updateNote(db, id, {
      title: 'Stale',
      updatedAt: '2026-09-13T00:00:00.000Z',
    });
    expect(stale.body).toMatchObject({ applied: false });
    expect(noteRow(id).title).toBe('Saved note');
    expect(
      (await updateNote(db, id, { title: 'Newer offline edit', updatedAt: cursor })).body
    ).toMatchObject({ applied: true });
    expect(noteRow(id)).toMatchObject({ title: 'Newer offline edit', metadataUpdatedAt: cursor });
  });

  it('keeps future client timestamps instead of moving the delivery clock backwards', async () => {
    const id = await addNote(null, FUTURE);
    expect(noteRow(id)).toMatchObject({ updatedAt: FUTURE, metadataUpdatedAt: FUTURE });
  });
});
