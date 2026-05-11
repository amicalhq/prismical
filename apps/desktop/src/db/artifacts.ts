import { and, desc, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { v4 as uuid } from "uuid";
import { db as defaultDb } from "./index";
import {
  artifacts,
  type ArtifactMode,
  type Artifact,
  type NewArtifact,
} from "./schema";

type DB = LibSQLDatabase<Record<string, unknown>>;

// -------------------------------------------------------------------------
// v0.3 compat layer
//
// The note-wrapper "AI Summary" tab and `note-generation-service.ts` predate
// PRSM-2 Skills and read/write artifacts via these three functions. They
// stay alive through Plan 1 so the v0.3 surface keeps running unchanged.
// Plan 5 (invocation surfaces) replaces this surface with the sparkle
// button; at that point these three functions and the corresponding tRPC
// endpoints can be deleted.
//
// `kind` is the legacy parameter name (now stored as `skill_id` after the
// rename). `mode` is always `replace-doc` and `version` is always 1 for
// rows written through this layer — these legacy rows are not part of the
// new append-only audit semantics.
// -------------------------------------------------------------------------

export async function getLatestArtifactByNote(
  noteId: number,
  kind = "summary",
): Promise<Artifact | null> {
  const [row] = await defaultDb
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.noteId, noteId), eq(artifacts.skillId, kind)))
    .orderBy(desc(artifacts.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function createOrReplaceArtifact(
  data: Omit<
    NewArtifact,
    "id" | "createdAt" | "updatedAt" | "skillId" | "mode" | "version"
  > & {
    kind?: string;
  },
): Promise<Artifact> {
  const kind = data.kind ?? "summary";
  const existing = await getLatestArtifactByNote(data.noteId, kind);
  const now = new Date();

  if (existing) {
    const [updated] = await defaultDb
      .update(artifacts)
      .set({
        content: data.content,
        generator: data.generator,
        modelId: data.modelId ?? null,
        meta: data.meta ?? null,
        generatedAt: data.generatedAt ?? now,
        updatedAt: now,
      })
      .where(eq(artifacts.id, existing.id))
      .returning();
    return updated;
  }

  const [inserted] = await defaultDb
    .insert(artifacts)
    .values({
      id: uuid(),
      noteId: data.noteId,
      skillId: kind,
      mode: "replace-doc",
      version: 1,
      content: data.content,
      generator: data.generator,
      modelId: data.modelId ?? null,
      meta: data.meta ?? null,
      generatedAt: data.generatedAt ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return inserted;
}

export async function updateArtifactContent(
  artifactId: string,
  content: string,
): Promise<Artifact | null> {
  const [updated] = await defaultDb
    .update(artifacts)
    .set({ content, updatedAt: new Date() })
    .where(eq(artifacts.id, artifactId))
    .returning();
  return updated ?? null;
}

// -------------------------------------------------------------------------
// PRSM-2 append-only audit layer
//
// New code (skill runtime in Plan 3, Skills page in Plan 6) uses these.
// Db handle is injected so tests can use createTestDatabase().
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
