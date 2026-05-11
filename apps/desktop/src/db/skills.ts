import { and, desc, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { v4 as uuid } from "uuid";
import {
  skills,
  type Skill,
  type SkillConfig,
  type SkillSurface,
} from "./schema";

type DB = LibSQLDatabase<Record<string, unknown>>;

export interface CreateSkillInput {
  slug: string;
  name: string;
  description?: string | null;
  iconUrl?: string | null;
  body: string;
  config: SkillConfig;
  metadata?: Record<string, unknown>;
  allowedTools?: string[] | null;
  createdBy?: string | null;
  orgId?: string | null;
  system?: boolean;
  public?: boolean;
  featured?: boolean;
  enabled?: boolean;
  parentSkillId?: string | null;
}

export async function createSkill(
  db: DB,
  input: CreateSkillInput,
): Promise<Skill> {
  const now = new Date();
  const [row] = await db
    .insert(skills)
    .values({
      id: uuid(),
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      iconUrl: input.iconUrl ?? null,
      body: input.body,
      metadata: input.metadata ?? {},
      config: input.config,
      allowedTools: input.allowedTools ?? null,
      createdBy: input.createdBy ?? null,
      orgId: input.orgId ?? null,
      system: input.system ?? false,
      public: input.public ?? false,
      featured: input.featured ?? false,
      enabled: input.enabled ?? true,
      parentSkillId: input.parentSkillId ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function seedSkillIfMissing(
  db: DB,
  input: CreateSkillInput,
): Promise<void> {
  const existing = await getSkillBySlug(db, input.slug);
  if (existing) return;
  await createSkill(db, input);
}

export async function getSkillById(db: DB, id: string): Promise<Skill | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(eq(skills.id, id))
    .limit(1);
  return row ?? null;
}

export async function getSkillBySlug(
  db: DB,
  slug: string,
): Promise<Skill | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(eq(skills.slug, slug))
    .limit(1);
  return row ?? null;
}

export interface ListSkillsOptions {
  onlyEnabled?: boolean;
}

export async function listSkills(
  db: DB,
  opts: ListSkillsOptions = {},
): Promise<Skill[]> {
  let q = db.select().from(skills).orderBy(desc(skills.createdAt)).$dynamic();
  if (opts.onlyEnabled) {
    q = q.where(eq(skills.enabled, true));
  }
  return await q;
}

// Filter on the JSON `config.surface` array. SQLite has no native JSON
// containment; we use json_each + EXISTS to ask "does the array contain X".
export async function listEnabledSkillsForSurface(
  db: DB,
  surface: SkillSurface,
): Promise<Skill[]> {
  return await db
    .select()
    .from(skills)
    .where(
      and(
        eq(skills.enabled, true),
        sql`EXISTS (
          SELECT 1 FROM json_each(${skills.config}, '$.surface')
          WHERE json_each.value = ${surface}
        )`,
      ),
    )
    .orderBy(desc(skills.createdAt));
}

export type UpdateSkillPatch = Partial<
  Pick<
    Skill,
    | "name"
    | "description"
    | "iconUrl"
    | "body"
    | "enabled"
    | "config"
    | "metadata"
    | "allowedTools"
  >
>;

export async function updateSkill(
  db: DB,
  id: string,
  patch: UpdateSkillPatch,
): Promise<Skill> {
  const [row] = await db
    .update(skills)
    .set({
      ...patch,
      version: sql`${skills.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(skills.id, id))
    .returning();
  if (!row) {
    throw new Error(`Skill not found: ${id}`);
  }
  return row;
}

export async function deleteSkill(db: DB, id: string): Promise<void> {
  await db.delete(skills).where(eq(skills.id, id));
}
