import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { db as defaultDb } from "../db";
import { seedSkillIfMissing, type CreateSkillInput } from "../db/skills";
import { logger } from "../main/logger";

type DB = LibSQLDatabase<Record<string, unknown>>;

const ENHANCE_BODY = `You are the "enhance" skill.

The user's note (rendered as markdown) is provided in the system prompt under "# Note (markdown)". If the note is linked to a meeting, its transcript appears under "# Meeting transcript".

Produce a brief Summary section and an Action items section as markdown. Be terse. No filler. Skip a section if there's nothing meaningful to say. Your output will be appended to the note as a new block.`;

const CLEANUP_BODY = `You are the "cleanup" skill.

The user's note (rendered as markdown) is provided in the system prompt under "# Note (markdown)". **Use only the note markdown below**; ignore any external context that isn't present in the system prompt. Do not introduce facts that aren't in the note.

Rewrite the note as clean, well-organized markdown — preserve every fact and intent, fix grammar and structure, remove filler. Your output will replace the entire note body.`;

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
      // Enhance can pull from the meeting transcript when one is linked —
      // that's where most of the value lives for recorded notes.
      inputs: { transcript: true },
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
      // Cleanup is note-only by design — never see the transcript so we
      // can't accidentally add facts the user didn't write.
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
