import { and, desc, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { v4 as uuid } from "uuid";
import {
  artifacts,
  type ArtifactMode,
  type Artifact,
} from "./schema";

type DB = LibSQLDatabase<Record<string, unknown>>;

// -------------------------------------------------------------------------
// Append-only audit layer. Db handle is injected so tests can use
// createTestDatabase().
// -------------------------------------------------------------------------

export interface AppendArtifactInput {
  noteId: number;
  skillId: string;
  mode: ArtifactMode;
  content: string;
  generator: string;
  modelId?: string | null;
  meta?: Record<string, unknown> | null;
  generatedAt?: Date;
  // LLM token usage at the moment the candidate was produced (t-07).
  // Optional because not every generator is an LLM and some providers
  // don't surface usage. `raw` is the full LanguageModelUsage
  // JSON-stringified for forward-compat (Gemini cache details, etc.).
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    raw?: string;
  };
}

export async function appendArtifact(
  db: DB,
  input: AppendArtifactInput,
): Promise<Artifact> {
  // For append-section, version monotonically increases within (noteId,
  // skillId). For replace-doc / inline-rewrite each row stands alone so
  // version stays at 1.
  const version =
    input.mode === "append-section"
      ? await nextVersionForAppendSection(db, input.noteId, input.skillId)
      : 1;

  const now = new Date();
  const [row] = await db
    .insert(artifacts)
    .values({
      id: uuid(),
      noteId: input.noteId,
      skillId: input.skillId,
      mode: input.mode,
      version,
      content: input.content,
      generator: input.generator,
      modelId: input.modelId ?? null,
      meta: input.meta ?? null,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      totalTokens: input.usage?.totalTokens ?? null,
      rawUsageJson: input.usage?.raw ?? null,
      generatedAt: input.generatedAt ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

async function nextVersionForAppendSection(
  db: DB,
  noteId: number,
  skillId: string,
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`MAX(${artifacts.version})` })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.noteId, noteId),
        eq(artifacts.skillId, skillId),
        eq(artifacts.mode, "append-section"),
      ),
    );
  return (row?.max ?? 0) + 1;
}

export async function listArtifactsByNote(
  db: DB,
  noteId: number,
): Promise<Artifact[]> {
  return await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.noteId, noteId))
    .orderBy(desc(artifacts.generatedAt));
}

export async function listArtifactsByNoteAndSkill(
  db: DB,
  noteId: number,
  skillId: string,
): Promise<Artifact[]> {
  return await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.noteId, noteId), eq(artifacts.skillId, skillId)))
    .orderBy(desc(artifacts.version), desc(artifacts.generatedAt));
}
