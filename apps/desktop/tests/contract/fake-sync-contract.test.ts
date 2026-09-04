/* eslint-disable @typescript-eslint/no-explicit-any -- response-body assertions use `as any` for envelope ergonomics, matching the server contract suite */
/**
 * Twin contract suite: the same dialect pins as the server sync contract
 * suite, run against the fake sync server
 * (e2e/helpers/fake-sync.ts) over real HTTP. Together the two suites are the
 * anti-drift anchor: the server suite defines the dialect, this one proves the
 * fake still speaks it — so e2e green against the fake keeps meaning
 * something. Change all three (server suite / fake / this suite) together.
 *
 * Plus fake-only pins the server cannot express yet:
 *   - the bare /me/* alias 404s (the server still serves the alias
 *     until its sunset, so only the fake can enforce the client never uses it),
 *   - fault injection (failNext / latencyMs) behaves as the e2e specs assume.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@prismical/id';
import { startFakeSyncServer, type FakeSyncServer } from '../../e2e/helpers/fake-sync';

const OU = 'ou_contract_1';
const H = { 'x-org-user-id': OU, 'content-type': 'application/json' };

let fake: FakeSyncServer;
const url = (path: string) => `${fake.origin}${path}`;
const BASE = '/apps/v1/me';

const listOf = async (res: Response) => ((await res.json()) as { results: Record<string, unknown>[] }).results;

const post = (path: string, body: unknown) =>
  fetch(url(path), { method: 'POST', headers: H, body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
  fetch(url(path), { method: 'PUT', headers: H, body: JSON.stringify(body) });
const del = (path: string) => fetch(url(path), { method: 'DELETE', headers: H });
const get = (path: string) => fetch(url(path), { headers: H });

beforeAll(async () => {
  fake = await startFakeSyncServer();
});

afterAll(async () => {
  await fake.close();
});

describe('versioned path only (fake-only pin)', () => {
  it('the bare /me/* alias does NOT exist here', async () => {
    const res = await get('/me/tags');
    expect(res.status).toBe(404);
  });

  it('identity is required on the versioned lane', async () => {
    const res = await fetch(url(`${BASE}/tags`)); // no identity header
    expect(res.status).toBe(401);
  });
});

describe('delta list', () => {
  const T1 = '2030-01-01T00:00:00.000Z';
  const T2 = '2030-01-02T00:00:00.000Z';
  const idA = createId('tag');
  const idB = createId('tag');

  beforeAll(() => {
    fake.seed(OU, 'tags', [
      { id: idA, name: 'DeltaA', color: '#111', createdAt: T1, updatedAt: T1 },
      { id: idB, name: 'DeltaB', color: '#222', createdAt: T2, updatedAt: T2 },
    ]);
  });

  it('since is STRICT gt (ISO)', async () => {
    const ids = (await listOf(await get(`${BASE}/tags?since=${T1}`))).map(r => r.id);
    expect(ids).toContain(idB);
    expect(ids).not.toContain(idA);
  });

  it('since accepts epoch-ms', async () => {
    const ids = (await listOf(await get(`${BASE}/tags?since=${new Date(T1).getTime()}`))).map(r => r.id);
    expect(ids).toContain(idB);
    expect(ids).not.toContain(idA);
  });

  it('envelope {success:true, results} ordered (updatedAt, id)', async () => {
    const res = await get(`${BASE}/tags`);
    const body = (await res.json()) as { success: boolean; results: Record<string, unknown>[] };
    expect(body.success).toBe(true);
    const mine = body.results.filter(r => [idA, idB].includes(r.id as string));
    expect(mine.map(r => r.id)).toEqual([idA, idB]);
  });
});

describe('writes', () => {
  it('PUT on an unknown id is 404', async () => {
    const res = await put(`${BASE}/tags/${createId('tag')}`, { name: 'Ghost', color: '#333' });
    expect(res.status).toBe(404);
  });

  it('POST persists a client-minted id verbatim, 201, createdAt backfilled', async () => {
    const id = createId('tag');
    const res = await post(`${BASE}/tags`, { id, name: 'Mint', color: '#444' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({ success: true, created: true, applied: true });
    expect(body.result.id).toBe(id);
    expect(body.result.createdAt).toBeTruthy();
  });

  it('POST with a foreign entity prefix is 400', async () => {
    const res = await post(`${BASE}/vocabulary`, { id: createId('note'), word: 'w' });
    expect(res.status).toBe(400);
  });

  it('stale write → 200 applied:false + server-winning row', async () => {
    const id = createId('tag');
    await post(`${BASE}/tags`, { id, name: 'Fresh', color: '#555', updatedAt: '2031-01-02T00:00:00.000Z' });
    const res = await post(`${BASE}/tags`, { id, name: 'Stale', color: '#000', updatedAt: '2031-01-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.applied).toBe(false);
    expect(body.result.name).toBe('Fresh');
  });

  it('partial PUT keeps unsent fields', async () => {
    const id = createId('tag');
    await post(`${BASE}/tags`, { id, name: 'Part', color: '#666' });
    const res = await put(`${BASE}/tags/${id}`, { name: 'PartB' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, any>).result.color).toBe('#666');
  });

  it('tag-name is normalized on the way in; case-insensitive collision is 409', async () => {
    const id = createId('tag');
    const res = await post(`${BASE}/tags`, { id, name: 'My Work!', color: '#777' });
    expect(((await res.json()) as Record<string, any>).result.name).toBe('MyWork');
    const collide = await post(`${BASE}/tags`, { id: createId('tag'), name: 'mywork', color: '#888' });
    expect(collide.status).toBe(409);
  });
});

describe('tombstones', () => {
  it('DELETE is exactly {success:true}; row hidden live, present under includeDeleted with bumped updatedAt', async () => {
    const id = createId('tag');
    await post(`${BASE}/tags`, { id, name: 'Tomb', color: '#999' }); // server-now stamp, like a real create
    const preDelete = new Date(
      ((await listOf(await get(`${BASE}/tags?includeDeleted=1`))).find(r => r.id === id)!.updatedAt) as string
    );
    const delRes = await del(`${BASE}/tags/${id}`);
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ success: true });

    const live = (await listOf(await get(`${BASE}/tags`))).map(r => r.id);
    expect(live).not.toContain(id);

    const tomb = (await listOf(await get(`${BASE}/tags?includeDeleted=1`))).find(r => r.id === id)!;
    expect(tomb.deletedAt).toBeTruthy();
    // The bump carries the delete past cursors ≥ the live row's stamp.
    expect(new Date(tomb.updatedAt as string).getTime()).toBeGreaterThanOrEqual(preDelete.getTime());
  });

  it('re-DELETE is 404 (client ack)', async () => {
    const id = createId('tag');
    await post(`${BASE}/tags`, { id, name: 'Twice', color: '#aaa' });
    await del(`${BASE}/tags/${id}`);
    expect((await del(`${BASE}/tags/${id}`)).status).toBe(404);
  });

  it('a tombstoned row can be LWW-updated but never revived (delete-wins)', async () => {
    const id = createId('tag');
    await post(`${BASE}/tags`, { id, name: 'Dead', color: '#bbb' });
    await del(`${BASE}/tags/${id}`);
    await post(`${BASE}/tags`, { id, name: 'Zombie', color: '#ccc' });
    const tomb = (await listOf(await get(`${BASE}/tags?includeDeleted=1`))).find(r => r.id === id)!;
    expect(tomb.deletedAt).toBeTruthy(); // still dead
  });
});

describe('notes lane', () => {
  const noteId = createId('note');
  const folderId = createId('folder');

  beforeAll(async () => {
    await post(`${BASE}/folders`, { id: folderId, name: 'Contract Folder' });
    fake.seed(OU, 'notes', [
      {
        id: noteId,
        title: 'Contract Note',
        folderId,
        starred: false,
        contentText: 'body text for the excerpt derivation check',
        createdAt: '2030-01-01T00:00:00.000Z',
        updatedAt: '2030-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('list rows carry derived fields, excerpt from body, folderName joined — and no contentText by default', async () => {
    const row = (await listOf(await get(`${BASE}/notes`))).find(r => r.id === noteId)!;
    expect(row.excerpt).toBe('body text for the excerpt derivation check');
    expect(row.folderName).toBe('Contract Folder');
    expect(row.isOwner).toBe(true);
    expect(row.canWrite).toBe(true);
    expect('contentText' in row).toBe(false);
  });

  it('includeBody=1 adds contentText and composes with since', async () => {
    const row = (await listOf(await get(`${BASE}/notes?includeBody=1`))).find(r => r.id === noteId)!;
    expect(row.contentText).toBe('body text for the excerpt derivation check');
    const later = await listOf(await get(`${BASE}/notes?includeBody=1&since=${new Date('2099-01-01').toISOString()}`));
    expect(later).toEqual([]);
  });

  it('write echo is the RAW row — no derived fields', async () => {
    const id = createId('note');
    const res = await post(`${BASE}/notes`, { id, title: 'Echo' });
    expect(res.status).toBe(201);
    const echoed = ((await res.json()) as Record<string, any>).result;
    expect('excerpt' in echoed).toBe(false);
    expect('canWrite' in echoed).toBe(false);
    expect('isOwner' in echoed).toBe(false);
  });
});

describe('note-tags junction', () => {
  const nId = createId('note');
  const tId = createId('tag');

  beforeAll(async () => {
    await post(`${BASE}/notes`, { id: nId, title: 'J' });
    await post(`${BASE}/tags`, { id: tId, name: 'JTag', color: '#ddd' });
  });

  it('link to a missing parent is 404', async () => {
    expect((await post(`${BASE}/note-tags`, { noteId: createId('note'), tagId: tId })).status).toBe(404);
  });

  it('POST echo carries ONLY {noteId, tagId}', async () => {
    const res = await post(`${BASE}/note-tags`, { noteId: nId, tagId: tId });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, result: { noteId: nId, tagId: tId } });
  });

  it('delta list supports since + includeDeleted; rows carry updatedAt', async () => {
    const rows = await listOf(await get(`${BASE}/note-tags?includeDeleted=1&since=${new Date('2000-01-01').toISOString()}`));
    const row = rows.find(r => r.noteId === nId && r.tagId === tId)!;
    expect(row.updatedAt).toBeTruthy();
  });

  it('unlink {success:true}; replay 404 (ack)', async () => {
    const first = await del(`${BASE}/note-tags/${nId}/${tId}`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true });
    expect((await del(`${BASE}/note-tags/${nId}/${tId}`)).status).toBe(404);
  });
});

describe('fault injection (e2e assumptions)', () => {
  it('failNext fails exactly N requests with the given status, then recovers', async () => {
    fake.failNext(2, 503);
    expect((await get(`${BASE}/tags`)).status).toBe(503);
    expect((await get(`${BASE}/tags`)).status).toBe(503);
    expect((await get(`${BASE}/tags`)).status).toBe(200);
  });

  it('requests are recorded with query params (the "second boot sends since=" e2e hook)', async () => {
    await get(`${BASE}/tags?since=123&includeDeleted=1`);
    const last = fake.requests.at(-1)!;
    expect(last.path).toBe(`${BASE}/tags`);
    expect(last.query).toEqual({ since: '123', includeDeleted: '1' });
  });
});
