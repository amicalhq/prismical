import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  AcceptSkillRunResultSchema,
  EnhancedRecordingsQuerySchema,
  ResolveSkillResultSchema,
  RunSkillResultSchema,
  type RunSkillResult,
} from '@prismical/api-contracts/apps/v1';
import * as schema from '../../infra/product-db/schema';
import { apiError, forbidden, invalidRequest, ok, type LocalDb, type RouteResult } from './wire';

export class SuggestionChanged extends Error {}

export const suggestionChanged = (): RouteResult =>
  apiError(
    409,
    'SUGGESTION_CHANGED',
    'This suggestion is unavailable or has changed. Reopen the note to review it.'
  );

// The ProductDb file belongs to one workspace/member; every lookup also pins the note.
const liveNote = (noteId: string) =>
  and(eq(schema.note.id, noteId), isNull(schema.note.deletedAt), isNull(schema.note.trashedAt));

export const requiresDurableSkillProtocol = (result: RunSkillResult): boolean =>
  Boolean(result.recoveryContext);

export function pendingSkillResults(
  db: LocalDb,
  query: Record<string, string>,
  durable = false
): RouteResult {
  const input = EnhancedRecordingsQuerySchema.safeParse(query);
  if (!input.success) return invalidRequest('Invalid note');
  if (!db.select({ id: schema.note.id }).from(schema.note).where(liveNote(input.data.noteId)).get())
    return forbidden();
  const rows = db
    .select()
    .from(schema.noteSkillResult)
    .where(
      and(
        eq(schema.noteSkillResult.noteId, input.data.noteId),
        isNull(schema.noteSkillResult.resolvedAt),
        sql`json_extract(${schema.noteSkillResult.result}, '$._receiptOnly') is not 1`,
        durable
          ? undefined
          : sql`json_extract(${schema.noteSkillResult.result}, '$.recoveryContext') is null`
      )
    )
    .orderBy(asc(schema.noteSkillResult.createdAt), asc(schema.noteSkillResult.id))
    .limit(20)
    .all();
  return ok({
    results: rows.map(row => {
      const result = { ...RunSkillResultSchema.parse(row.result), resultId: row.id };
      if (!row.acceptedResult) return result;
      const accepted = AcceptSkillRunResultSchema.parse(row.acceptedResult);
      const artifact = db
        .select({ prevContent: schema.artifact.prevContent })
        .from(schema.artifact)
        .where(
          and(
            eq(schema.artifact.id, accepted.artifactId),
            eq(schema.artifact.noteId, input.data.noteId)
          )
        )
        .get();
      return {
        ...result,
        acceptance: { result: accepted, prevContent: artifact?.prevContent ?? undefined },
      };
    }),
  });
}

export function resolveSkillResult(db: LocalDb, body: unknown, durable = false): RouteResult {
  const input = ResolveSkillResultSchema.safeParse(body);
  if (!input.success) return invalidRequest('Invalid result');
  if (!db.select({ id: schema.note.id }).from(schema.note).where(liveNote(input.data.noteId)).get())
    return forbidden();
  return db.transaction(tx => {
    const saved = tx
      .select()
      .from(schema.noteSkillResult)
      .where(
        and(
          eq(schema.noteSkillResult.id, input.data.resultId),
          eq(schema.noteSkillResult.noteId, input.data.noteId)
        )
      )
      .get();
    if (!saved) return forbidden();
    if (!durable && requiresDurableSkillProtocol(RunSkillResultSchema.parse(saved.result)))
      return suggestionChanged();
    const now = new Date().toISOString();
    if (input.data.discardAccepted && saved.acceptedResult) {
      const accepted = AcceptSkillRunResultSchema.parse(saved.acceptedResult);
      if (accepted.applicationUpdate)
        return apiError(
          409,
          'INVALID_REQUEST',
          'This suggestion has already been committed. Reopen the note to finish applying it.'
        );
      tx.update(schema.artifact)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.artifact.id, accepted.artifactId),
            eq(schema.artifact.noteId, input.data.noteId)
          )
        )
        .run();
    }
    tx.update(schema.noteSkillResult)
      .set({
        resolvedAt: now,
        ...(input.data.discardAccepted ? { acceptedResult: null } : {}),
      })
      .where(eq(schema.noteSkillResult.id, saved.id))
      .run();
    return ok({ resolved: true });
  });
}

export function findRecoverableResult(
  db: LocalDb,
  noteId: string,
  recordingId: string,
  skillId: string
) {
  const row = db
    .select()
    .from(schema.noteSkillResult)
    .where(
      and(
        eq(schema.noteSkillResult.noteId, noteId),
        isNull(schema.noteSkillResult.resolvedAt),
        sql`json_extract(${schema.noteSkillResult.result}, '$._receiptOnly') is not 1`,
        sql`json_extract(${schema.noteSkillResult.result}, '$.recordingId') = ${recordingId}`,
        sql`json_extract(${schema.noteSkillResult.result}, '$.skillId') = ${skillId}`
      )
    )
    .limit(1)
    .get();
  return row ? { ...RunSkillResultSchema.parse(row.result), resultId: row.id } : null;
}

/** Commit output before returning it; each refinement gets its own application identity. */
export function saveRecoverableResult(
  db: LocalDb,
  noteId: string,
  result: RunSkillResult,
  recovery?: { id: string; result: RunSkillResult },
  retainOnly?: boolean
): string {
  const storedResult = { ...result, ...(retainOnly ? { _receiptOnly: true } : {}) };
  return db.transaction(tx => {
    if (!tx.select({ id: schema.note.id }).from(schema.note).where(liveNote(noteId)).get())
      throw new Error('Note is unavailable');
    if (recovery) {
      const updated = tx
        .update(schema.noteSkillResult)
        .set({ resolvedAt: new Date().toISOString() })
        .where(
          and(
            eq(schema.noteSkillResult.id, recovery.id),
            eq(schema.noteSkillResult.noteId, noteId),
            eq(schema.noteSkillResult.result, recovery.result),
            isNull(schema.noteSkillResult.resolvedAt),
            isNull(schema.noteSkillResult.acceptedResult)
          )
        )
        .returning({ id: schema.noteSkillResult.id })
        .get();
      if (!updated)
        throw new SuggestionChanged('Suggestion changed or was resolved while refining');
    }
    const id = `nsr_${randomUUID().replace(/-/g, '')}`;
    tx.insert(schema.noteSkillResult)
      .values({ id, noteId, result: storedResult, createdAt: new Date().toISOString() })
      .run();
    return id;
  });
}
