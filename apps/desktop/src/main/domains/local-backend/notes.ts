/**
 * The notes lane is the dedicated /apps/v1/me/notes dialect, mirroring the
 * observable behavior of the server's notes and note-title-write semantics
 * over the product store:
 *
 *  - LIST rows are raw note metadata plus JOINED/derived per-caller fields
 *    (excerpt from the plain-text body, folderName, isOwner/canWrite true,
 *    sharedByName null — sharing is not modeled locally); the FULL body
 *    (`contentText` = coalesce(contentMarkdown, contentText)) is opt-in via
 *    ?includeBody=1. Write echoes are the RAW row — derived fields survive on
 *    the client by ABSENCE, and the body read-model columns never echo.
 *  - The client write stamp lands in `metadataUpdatedAt` (LWW compares
 *    against it); the row `updatedAt` advances to
 *    max(now, incoming, current + 1ms) so the delta cursor never moves
 *    backwards under backdated offline writes.
 *  - Titles: blank/absent title on a genuinely-new row → the local default
 *    ('Untitled note', titleSource 'placeholder' — no calendar locally);
 *    an empty-string title on PUT resets to the default (following the body's
 *    firstLine when one exists); an explicit title is trimmed, stamped
 *    titleSource 'manual', and advances titleRevision exactly as core's
 *    prepareNoteTitle does (retried creates never demote a manual title).
 */
import { and, asc, eq, gt, isNull, type SQL } from 'drizzle-orm';
import { getEntityPrefix, isValidPrefixedId } from '@prismical/id';
import { createId } from '@prismical/id';
import {
  SyncNoteCreateRequestSchema,
  SyncNoteUpdateRequestSchema,
} from '@prismical/api-contracts/apps/v1';
import * as schema from '../../infra/product-db/schema';
import {
  invalidRequest,
  notFound,
  ok,
  parseTimestampMs,
  queryFlag,
  type LocalDb,
  type RouteResult,
  issueSummary,
} from './wire';

type NoteRow = typeof schema.note.$inferSelect;

export const UNTITLED_NOTE = 'Untitled note';

const invalidNoteId = (id: string): RouteResult =>
  invalidRequest(`Invalid id "${id}": expected a "${getEntityPrefix('note')}_"-prefixed id`);

/** The stored row minus the body read-model — the RAW write echo (and the LWW winner echo). */
const rawEcho = (row: NoteRow): Record<string, unknown> => {
  const { contentMarkdown: _md, contentText: _text, firstLine: _first, ...raw } = row;
  return raw;
};

/** Trim a client-supplied title to a usable value, or undefined when blank/absent. */
const cleanTitle = (title: string | undefined): string | undefined => {
  const t = title?.trim();
  return t ? t : undefined;
};

/** Local defaultNoteName: first body line, else the placeholder. */
export const defaultTitle = (
  previous: NoteRow | undefined
): { title: string; titleSource: string } =>
  previous?.firstLine
    ? { title: previous.firstLine, titleSource: 'first-line' }
    : { title: UNTITLED_NOTE, titleSource: 'placeholder' };

interface TitleInputs {
  /** Route-prepared title: trimmed non-empty, '' (explicit reset), or undefined (untouched). */
  readonly title: string | undefined;
  readonly titleIntent: 'default' | undefined;
  /** Whether the client sent a title string at all (core's `raw.title`). */
  readonly rawTitleWasString: boolean;
  /** The eventId about to be written; undefined = untouched. */
  readonly nextEventId: string | null | undefined;
}

/** Core's prepareNoteTitle, replayed over the local row (event lookup elided). */
const resolveNoteTitle = (
  previous: NoteRow | undefined,
  inputs: TitleInputs,
  incomingMs: number
): { title?: string; titleSource?: string; titleRevision?: number } => {
  let title = inputs.title;
  // A retried create can arrive after a body save or a rename. Its placeholder
  // is not an explicit rename and must not turn a derived title into a manual one.
  if (previous !== undefined && inputs.titleIntent === 'default') title = undefined;
  const reset = title === '' || (previous === undefined && inputs.titleIntent === 'default');
  const eventChanged =
    previous !== undefined &&
    inputs.nextEventId !== undefined &&
    inputs.nextEventId !== previous.eventId;
  const followsDefault = ['placeholder', 'first-line', 'calendar'].includes(
    String(previous?.titleSource)
  );
  let next: { title?: string; titleSource?: string } = {};
  if (
    reset ||
    (previous === undefined && !String(title ?? '').trim()) ||
    (eventChanged && followsDefault && !inputs.rawTitleWasString)
  ) {
    next = defaultTitle(previous);
  } else if (typeof title === 'string') {
    next = { title: title.trim(), titleSource: 'manual' };
  }
  if (next.title === undefined) return {};
  const changed =
    previous !== undefined &&
    (previous.title !== next.title || previous.titleSource !== next.titleSource);
  // An explicit reset/rename is still an intent when its resolved text is
  // unchanged; an exact retry (same stamp and value) must not advance again.
  const freshIntent =
    previous !== undefined &&
    inputs.rawTitleWasString &&
    inputs.titleIntent !== 'default' &&
    incomingMs > Date.parse(previous.metadataUpdatedAt);
  return {
    ...next,
    titleRevision: (previous?.titleRevision ?? 0) + (changed || freshIntent ? 1 : 0),
  };
};

/** Monotonic row stamp: never behind now, the incoming stamp, or the stored stamp + 1ms. */
export const bumpUpdatedAt = (current: string, incomingMs: number): string =>
  new Date(Math.max(Date.now(), incomingMs, Date.parse(current) + 1)).toISOString();

const selectNote = async (db: LocalDb, id: string): Promise<NoteRow | undefined> => {
  const rows = await db.select().from(schema.note).where(eq(schema.note.id, id)).limit(1);
  return rows[0];
};

/** Core 404s a write naming a folder the caller cannot write; locally that is
 * "the folder row must exist" (tombstoned still passes, as core's
 * folderWriteAccess ignores the tombstone for the owner). */
const folderExists = async (db: LocalDb, folderId: string): Promise<boolean> => {
  const rows = await db
    .select({ id: schema.folder.id })
    .from(schema.folder)
    .where(eq(schema.folder.id, folderId))
    .limit(1);
  return rows.length > 0;
};

/** GET /apps/v1/me/notes?since&includeDeleted&includeBody — delta + derived fields. */
export const listNotes = async (
  db: LocalDb,
  query: Record<string, string>
): Promise<RouteResult> => {
  const conds: SQL[] = [];
  const sinceMs = parseTimestampMs(query.since);
  if (sinceMs !== null) conds.push(gt(schema.note.updatedAt, new Date(sinceMs).toISOString()));
  if (!queryFlag(query.includeDeleted)) conds.push(isNull(schema.note.deletedAt));
  const includeBody = queryFlag(query.includeBody);
  const rows = await db
    .select()
    .from(schema.note)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(schema.note.updatedAt), asc(schema.note.id));
  const folders = await db
    .select({ id: schema.folder.id, name: schema.folder.name })
    .from(schema.folder);
  const folderNames = new Map(folders.map(folder => [folder.id, folder.name]));
  const results = rows.map(row => {
    const {
      contentMarkdown,
      contentText,
      firstLine: _firstLine,
      metadataUpdatedAt: _metadataUpdatedAt,
      ...rest
    } = row;
    return {
      ...rest,
      folderName: row.folderId === null ? null : (folderNames.get(row.folderId) ?? null),
      excerpt: contentText ? contentText.slice(0, 100) : null,
      canWrite: true,
      isOwner: true,
      sharedByName: null,
      ...(includeBody ? { contentText: contentMarkdown ?? contentText } : {}),
    };
  });
  return ok({ success: true, results });
};

/** POST /apps/v1/me/notes — LWW upsert; the server defaults the title on create. */
export const createNote = async (db: LocalDb, body: unknown): Promise<RouteResult> => {
  const parsed = SyncNoteCreateRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest(issueSummary(parsed.error.issues, body));
  const { id, updatedAt, title, titleIntent, timezone: _timezone, ...fields } = parsed.data;
  if (id !== undefined && !isValidPrefixedId('note', id)) return invalidNoteId(id);
  if (typeof fields.folderId === 'string' && !(await folderExists(db, fields.folderId))) {
    return notFound();
  }
  const incomingMs = parseTimestampMs(updatedAt) ?? Date.now();
  const explicitTitle = cleanTitle(title);
  const existing = id !== undefined ? await selectNote(db, id) : undefined;

  if (existing !== undefined) {
    // LWW against the explicit-metadata clock, not the row clock.
    if (incomingMs < Date.parse(existing.metadataUpdatedAt)) {
      return ok({ success: true, result: rawEcho(existing), applied: false, created: false });
    }
    const titlePlan = resolveNoteTitle(
      existing,
      {
        title: explicitTitle,
        titleIntent,
        rawTitleWasString: explicitTitle !== undefined,
        nextEventId: fields.eventId,
      },
      incomingMs
    );
    const [updated] = await db
      .update(schema.note)
      .set({
        ...fields,
        ...titlePlan,
        metadataUpdatedAt: new Date(incomingMs).toISOString(),
        updatedAt: bumpUpdatedAt(existing.updatedAt, incomingMs),
      })
      .where(eq(schema.note.id, existing.id))
      .returning();
    return ok({ success: true, result: rawEcho(updated), applied: true, created: false });
  }

  const titlePlan = resolveNoteTitle(
    undefined,
    {
      title: explicitTitle,
      // A brand-new row with no usable title defaults server-side (core's route
      // stamps titleIntent:'default' before the engine runs).
      titleIntent: explicitTitle === undefined ? 'default' : titleIntent,
      rawTitleWasString: explicitTitle !== undefined,
      nextEventId: fields.eventId,
    },
    incomingMs
  );
  const incomingIso = new Date(incomingMs).toISOString();
  const [inserted] = await db
    .insert(schema.note)
    .values({
      ...fields,
      id: id ?? createId('note'),
      title: titlePlan.title ?? UNTITLED_NOTE,
      titleSource: titlePlan.titleSource ?? 'placeholder',
      titleRevision: titlePlan.titleRevision ?? 0,
      createdAt: new Date().toISOString(),
      updatedAt: incomingIso,
      metadataUpdatedAt: incomingIso,
      deletedAt: null,
    })
    .returning();
  return ok({ success: true, result: rawEcho(inserted), applied: true, created: true }, 201);
};

/** PUT /apps/v1/me/notes/:id — LWW metadata update; empty title = reset-to-default. */
export const updateNote = async (
  db: LocalDb,
  id: string,
  body: unknown
): Promise<RouteResult> => {
  if (!isValidPrefixedId('note', id)) return invalidNoteId(id);
  const parsed = SyncNoteUpdateRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const { updatedAt, title, ...fields } = parsed.data;
  if (typeof fields.folderId === 'string' && !(await folderExists(db, fields.folderId))) {
    return notFound();
  }
  const existing = await selectNote(db, id);
  if (existing === undefined) return notFound();
  const incomingMs = parseTimestampMs(updatedAt) ?? Date.now();
  if (incomingMs < Date.parse(existing.metadataUpdatedAt)) {
    return ok({ success: true, result: rawEcho(existing), applied: false, created: false });
  }
  // A blank title asks for the current default; absent leaves the title alone.
  const titlePlan = resolveNoteTitle(
    existing,
    {
      title: title === undefined ? undefined : (cleanTitle(title) ?? ''),
      titleIntent: undefined,
      rawTitleWasString: title !== undefined,
      nextEventId: fields.eventId,
    },
    incomingMs
  );
  const [updated] = await db
    .update(schema.note)
    .set({
      ...fields,
      ...titlePlan,
      metadataUpdatedAt: new Date(incomingMs).toISOString(),
      updatedAt: bumpUpdatedAt(existing.updatedAt, incomingMs),
    })
    .where(eq(schema.note.id, id))
    .returning();
  return ok({ success: true, result: rawEcho(updated), applied: true, created: false });
};

/** DELETE /apps/v1/me/notes/:id — tombstone + unpublish; replay → 404 (ack). */
export const removeNote = async (db: LocalDb, id: string): Promise<RouteResult> => {
  const existing = await selectNote(db, id);
  if (existing === undefined || existing.deletedAt !== null) return notFound();
  const nowMs = Date.now();
  await db
    .update(schema.note)
    .set({
      deletedAt: new Date(nowMs).toISOString(),
      // The bump carries the delete past cursors ≥ the live row's stamp; the
      // metadata clock never moves backwards either (engine tombstone parity).
      updatedAt: new Date(Math.max(nowMs, Date.parse(existing.updatedAt) + 1)).toISOString(),
      metadataUpdatedAt: new Date(
        Math.max(nowMs, Date.parse(existing.metadataUpdatedAt))
      ).toISOString(),
      // Deleting a note unpublishes it.
      publishedAt: null,
    })
    .where(eq(schema.note.id, id));
  return ok({ success: true });
};
