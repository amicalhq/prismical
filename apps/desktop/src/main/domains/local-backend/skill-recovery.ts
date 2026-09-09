import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
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
        isNull(schema.noteSkillResult.resolvedAt)
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
  const row = db
    .update(schema.noteSkillResult)
    .set({ resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(schema.noteSkillResult.id, input.data.resultId),
        eq(schema.noteSkillResult.noteId, input.data.noteId),
        sql`json_extract(${schema.noteSkillResult.result}, '$.rawMarkdown') = ${input.data.rawMarkdown}`,
        isNull(schema.noteSkillResult.acceptedResult)
      )
    )
    .returning({ id: schema.noteSkillResult.id })
    .get();
  if (row) return ok({ resolved: true });
  const owned = db.select({ id: schema.noteSkillResult.id }).from(schema.noteSkillResult).where(and(
    eq(schema.noteSkillResult.id, input.data.resultId),
    eq(schema.noteSkillResult.noteId, input.data.noteId)
  )).get();
  return owned ? suggestionChanged() : forbidden();
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
  recovery?: { id: string; result: RunSkillResult }
): string {
  return db.transaction(tx => {
    if (!tx.select({ id: schema.note.id }).from(schema.note).where(liveNote(noteId)).get())
      throw new Error('Note is unavailable');
    if (recovery) {
      const updated = tx
        .update(schema.noteSkillResult)
        .set({ result })
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
      .values({ id, noteId, result, createdAt: new Date().toISOString() })
      .run();
    return id;
  });
}
