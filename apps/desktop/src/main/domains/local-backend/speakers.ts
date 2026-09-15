/**
 * Local speaker identity uses the workspace database as its ownership boundary.
 * Tags are keyed by recording/channel and never rewrite transcript segments.
 * People and calendar integration remain cloud-only; local names and owner choices persist.
 */
import { and, asc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  RecordingSpeakerKeyParamsSchema,
  RenameRecordingSpeakerRequestSchema,
  TagRecordingSpeakerRequestSchema,
} from '@prismical/api-contracts/apps/v1';
import { LOCAL_WORKSPACE } from '@prismical/desktop-contracts';
import { createId } from '@prismical/id';
import * as schema from '../../infra/product-db/schema';
import {
  invalidRequest,
  notFound,
  ok,
  parseTimestampMs,
  type LocalDb,
  type RouteResult,
} from './wire';

type SpeakerRow = typeof schema.recordingSpeaker.$inferSelect;
type ReadDb = Pick<LocalDb, 'select'>;

const present = (row: SpeakerRow) => ({ ...row, orgUserId: LOCAL_WORKSPACE.orgUserId });

const liveRecording = (db: ReadDb, recordingId: string) =>
  db
    .select({ id: schema.recording.id })
    .from(schema.recording)
    .where(and(eq(schema.recording.id, recordingId), isNull(schema.recording.deletedAt)))
    .get();

export const listRecordingSpeakers = (db: LocalDb, query: Record<string, string>): RouteResult => {
  const conditions = [isNull(schema.recording.deletedAt)];
  if (query.recordingId)
    conditions.push(eq(schema.recordingSpeaker.recordingId, query.recordingId));
  const since = parseTimestampMs(query.since);
  if (since !== null)
    conditions.push(gt(schema.recordingSpeaker.updatedAt, new Date(since).toISOString()));
  const rows = db
    .select({ speaker: schema.recordingSpeaker })
    .from(schema.recordingSpeaker)
    .innerJoin(schema.recording, eq(schema.recording.id, schema.recordingSpeaker.recordingId))
    .where(and(...conditions))
    .orderBy(asc(schema.recordingSpeaker.updatedAt), asc(schema.recordingSpeaker.id))
    .all();
  return ok({ results: rows.map(({ speaker }) => present(speaker)) });
};

export const speakerCandidates = (db: LocalDb, recordingId: string): RouteResult =>
  liveRecording(db, recordingId) ? ok({ participants: [] }) : notFound();

export const tagRecordingSpeaker = (
  db: LocalDb,
  recordingId: string,
  rawSpeakerKey: string,
  body: unknown
): RouteResult => {
  let speakerKey: string;
  try {
    speakerKey = decodeURIComponent(rawSpeakerKey);
  } catch {
    return invalidRequest();
  }
  const params = RecordingSpeakerKeyParamsSchema.safeParse({ recordingId, speakerKey });
  const parsed = TagRecordingSpeakerRequestSchema.safeParse(body);
  if (!params.success || !parsed.success) return invalidRequest();
  // A foreign/cloud person can never be linked into the accountless local workspace.
  if (typeof parsed.data.personId === 'string') return notFound();
  const patch = parsed.data;

  return db.transaction(
    tx => {
      if (!liveRecording(tx, recordingId)) return notFound();
      const existing = tx
        .select()
        .from(schema.recordingSpeaker)
        .where(
          and(
            eq(schema.recordingSpeaker.recordingId, recordingId),
            eq(schema.recordingSpeaker.speakerKey, speakerKey)
          )
        )
        .get();
      if (
        !existing &&
        patch.displayName === undefined &&
        patch.personId === undefined &&
        patch.isOwner === false &&
        speakerKey !== 'you'
      )
        return notFound();

      const otherOwner =
        speakerKey === 'you' && !existing && patch.isOwner === undefined
          ? tx
              .select({ id: schema.recordingSpeaker.id })
              .from(schema.recordingSpeaker)
              .where(
                and(
                  eq(schema.recordingSpeaker.recordingId, recordingId),
                  eq(schema.recordingSpeaker.isOwner, true)
                )
              )
              .get()
          : undefined;

      // A strict delta cursor must also see rapid edits within the same millisecond.
      const latest = tx
        .select({ stamp: sql<string | null>`max(${schema.recordingSpeaker.updatedAt})` })
        .from(schema.recordingSpeaker)
        .where(eq(schema.recordingSpeaker.recordingId, recordingId))
        .get()?.stamp;
      const now = new Date(Math.max(Date.now(), latest ? Date.parse(latest) + 1 : 0)).toISOString();

      if (patch.isOwner === true) {
        tx.update(schema.recordingSpeaker)
          .set({ isOwner: false, updatedAt: now })
          .where(
            and(
              eq(schema.recordingSpeaker.recordingId, recordingId),
              eq(schema.recordingSpeaker.isOwner, true),
              ne(schema.recordingSpeaker.speakerKey, speakerKey)
            )
          )
          .run();
        // `you` is implicitly the owner until the user records an explicit Not me choice.
        if (speakerKey !== 'you') {
          tx.insert(schema.recordingSpeaker)
            .values({
              id: createId('recordingSpeaker'),
              recordingId,
              speakerKey: 'you',
              source: 'user',
              isOwner: false,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [schema.recordingSpeaker.recordingId, schema.recordingSpeaker.speakerKey],
              set: { source: 'user', isOwner: false, updatedAt: now },
            })
            .run();
        }
      }
      const row = tx
        .insert(schema.recordingSpeaker)
        .values({
          id: createId('recordingSpeaker'),
          recordingId,
          speakerKey,
          source: 'user',
          displayName: patch.displayName ?? null,
          personId: null,
          // Naming an unregistered mic voice must preserve its implicit owner identity.
          isOwner: patch.isOwner ?? existing?.isOwner ?? (speakerKey === 'you' && !otherOwner),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.recordingSpeaker.recordingId, schema.recordingSpeaker.speakerKey],
          set: {
            source: 'user',
            updatedAt: now,
            ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
            ...(patch.personId !== undefined ? { personId: null } : {}),
            ...(patch.isOwner !== undefined ? { isOwner: patch.isOwner } : {}),
          },
        })
        .returning()
        .get();
      return ok(present(row));
    },
    { behavior: 'immediate' }
  );
};

/** Legacy rename endpoint; share the same validation, transaction and delivery clock. */
export const renameRecordingSpeaker = (
  db: LocalDb,
  speakerId: string,
  body: unknown
): RouteResult => {
  const parsed = RenameRecordingSpeakerRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest();
  const row = db
    .select()
    .from(schema.recordingSpeaker)
    .where(eq(schema.recordingSpeaker.id, speakerId))
    .get();
  return row ? tagRecordingSpeaker(db, row.recordingId, row.speakerKey, parsed.data) : notFound();
};

const speakerLabel = (key: string, row: SpeakerRow | undefined): string => {
  const isOwner =
    key === 'you' ? !(row?.source === 'user' && row.isOwner === false) : row?.isOwner === true;
  // Every local reader is the recording owner; cloud viewer labels remain server-owned.
  if (isOwner) return 'You';
  if (row?.displayName) return row.displayName;
  if (key === 'you' || key === 'them') return 'Them';
  const numbered = /^dz:(\d+)$/.exec(key);
  if (numbered) return `Speaker ${Number(numbered[1]) + 1}`;
  return key.startsWith('dz:') ? 'Speaker' : key;
};

/** One registry read for all recordings in an Enhance/Ask input. */
export const loadSpeakerLabeler = (db: LocalDb, recordingIds: readonly string[]) => {
  const ids = [...new Set(recordingIds)];
  const rows = ids.length
    ? db
        .select()
        .from(schema.recordingSpeaker)
        .where(inArray(schema.recordingSpeaker.recordingId, ids))
        .all()
    : [];
  const byKey = new Map(rows.map(row => [`${row.recordingId}/${row.speakerKey}`, row]));
  return (recordingId: string, key: string): string =>
    speakerLabel(key, byKey.get(`${recordingId}/${key}`));
};
