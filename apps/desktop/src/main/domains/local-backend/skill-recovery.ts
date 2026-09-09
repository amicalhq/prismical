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

export const suggestionChanged = (): RouteResult => apiError(
  409,
  'SUGGESTION_CHANGED',
  'This suggestion is unavailable or has changed. Reopen the note to review it.'
);

// The ProductDb file belongs to one workspace/member; every lookup also pins the note.
const liveNote = (noteId: string) =>
  and(eq(schema.note.id, noteId), isNull(schema.note.deletedAt), isNull(schema.note.trashedAt));

export function pendingSkillResults(db: LocalDb, query: Record<string, string>): RouteResult {
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
        sql`json_extract(${schema.noteSkillResult.result}, '$._receiptOnly') is not 1`
      )
    )
    .orderBy(asc(schema.noteSkillResult.createdAt), asc(schema.noteSkillResult.id))
    .limit(20)
    .all();
  return ok({
    results: rows.map(row => ({ ...RunSkillResultSchema.parse(row.result), resultId: row.id })),
  });
}

export function resolveSkillResult(db: LocalDb, body: unknown): RouteResult {
  const input = ResolveSkillResultSchema.safeParse(body);
  if (!input.success) return invalidRequest('Invalid result');
  if (!db.select({ id: schema.note.id }).from(schema.note).where(liveNote(input.data.noteId)).get())
    return forbidden();
  return db.transaction(tx => {
    const saved = tx.select().from(schema.noteSkillResult).where(and(
      eq(schema.noteSkillResult.id, input.data.resultId),
      eq(schema.noteSkillResult.noteId, input.data.noteId)
    )).get();
    if (!saved) return forbidden();
    const now = new Date().toISOString();
    if (input.data.discardAccepted && saved.acceptedResult) {
      const accepted = AcceptSkillRunResultSchema.parse(saved.acceptedResult);
      tx.update(schema.artifact).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(schema.artifact.id, accepted.artifactId),
        eq(schema.artifact.noteId, input.data.noteId)
      )).run();
    }
    tx.update(schema.noteSkillResult).set({
      resolvedAt: now,
      ...(input.data.discardAccepted ? { acceptedResult: null } : {}),
    }).where(eq(schema.noteSkillResult.id, saved.id)).run();
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

/** Commit the completed output before returning it; refinement replaces the same pending row. */
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
        .set({ result: storedResult })
        .where(
          and(
            eq(schema.noteSkillResult.id, recovery.id),
            eq(schema.noteSkillResult.noteId, noteId),
            eq(schema.noteSkillResult.result, recovery.result),
            isNull(schema.noteSkillResult.resolvedAt)
          )
        )
        .returning({ id: schema.noteSkillResult.id })
        .get();
      if (!updated) throw new SuggestionChanged('Suggestion changed or was resolved while refining');
      return updated.id;
    }
    const id = `nsr_${randomUUID().replace(/-/g, '')}`;
    tx.insert(schema.noteSkillResult)
      .values({ id, noteId, result: storedResult, createdAt: new Date().toISOString() })
      .run();
    return id;
  });
}
