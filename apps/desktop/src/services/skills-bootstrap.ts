import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { db as defaultDb } from "../db";
import { seedSkillIfMissing, type CreateSkillInput } from "../db/skills";
import { logger } from "../main/logger";

type DB = LibSQLDatabase<Record<string, unknown>>;

const ENHANCE_BODY = `Produce a clean summary of the note's content. Branch on what's available:

- **Meeting transcript (multiple speakers)** → "Summary" and "Action items" sections. Action items name the owner when one is identified in the transcript.
- **Voice memo (single-speaker transcript)** → "Key points" and "Action items" sections. The user is thinking out loud — extract substance, drop verbal filler.
- **No transcript** → Work from the note alone. Use "Summary" and/or "Action items" — whichever fits.

Rules:
- Be terse. No filler, no preamble.
- Skip any section that would be empty or trivial.
- Do not invent items. Every action item must be grounded in what's actually in the note or transcript.
- The output is a self-contained chunk. After running, the user picks whether to append it to the note or use it as the new note body — write content that stands on its own in either case.`;

const CLEANUP_BODY = `Rewrite the note as clean, well-organized markdown.

- Preserve every fact and intent — no additions, no omissions.
- Fix grammar, spelling, and structure. Remove filler and repetition.
- Do not introduce facts that aren't in the note.`;

const SYSTEM_SKILLS: CreateSkillInput[] = [
  {
    slug: "enhance",
    name: "Enhance",
    description:
      "Default skill. Produces a summary chunk — append it or use it to replace the note.",
    body: ENHANCE_BODY,
    config: {
      editingOptions: "append-section",
      surface: ["dock", "inline"],
      defaultSkill: true,
      // Mode-agnostic prompt: the runtime doesn't inject "Produce a new
      // section" guidance for non-inline runs. Lets the user flip between
      // append and replace post-run via the diff action bar without
      // re-generating. inline-rewrite is exempt (always mode-tuned).
      modeAgnosticPrompt: true,
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
 * function — to update a seeded skill, edit it via the Skills page or via
 * a dedicated migration.
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
