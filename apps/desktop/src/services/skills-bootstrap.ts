import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { db as defaultDb } from "../db";
import { seedSkillIfMissing, type CreateSkillInput } from "../db/skills";
import { logger } from "../main/logger";

type DB = LibSQLDatabase<Record<string, unknown>>;

const ENHANCE_BODY = `You are the "enhance" skill. Read the user's raw note (read_note) and, if present, the meeting transcript (read_transcript).

Produce structured markdown — a brief Summary section and an Action items section — by calling write_section once with mode "append-section". Be terse. No filler. Skip a section if there's nothing meaningful to say.`;

const CLEANUP_BODY = `You are the "cleanup" skill. Read the user's note (read_note).

Rewrite it as clean, well-organized markdown — preserve every fact and intent, fix grammar and structure, remove filler. Output the full rewritten document by calling write_section once with mode "replace-doc". Do NOT call read_transcript.`;

const SYSTEM_SKILLS: CreateSkillInput[] = [
  {
    slug: "enhance",
    name: "Enhance",
    description:
      "Default skill. Append a Summary + Action items section to your note.",
    body: ENHANCE_BODY,
    config: {
      editingOptions: "append-section",
      surface: ["dock", "inline"],
      defaultSkill: true,
    },
    system: true,
  },
  {
    slug: "cleanup",
    name: "Cleanup",
    description: "Rewrite the entire note as clean markdown.",
    body: CLEANUP_BODY,
    config: {
      editingOptions: "replace-doc",
      surface: ["dock"],
    },
    system: true,
  },
];

/**
 * Idempotent: safe to run on every launch. Seeds the v1 system skills if
 * they do not already exist. Existing rows are never mutated by this
 * function — to update a seeded skill, edit it via the Skills page (Plan 6)
 * or via a dedicated migration.
 */
export async function bootstrapSkills(
  db: DB = defaultDb as unknown as DB,
): Promise<void> {
  for (const skill of SYSTEM_SKILLS) {
    await seedSkillIfMissing(db, skill);
  }
  logger.main.info("Seeded system skills (if missing)", {
    slugs: SYSTEM_SKILLS.map((s) => s.slug),
  });
}
