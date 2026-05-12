import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { SkillRunContext, WriteSectionPayload } from "../skill-context";
import { createReadNoteTool } from "./read-note";
import { createReadTranscriptTool } from "./read-transcript";
import { createWriteSectionTool } from "./write-section";
import { createReplaceSelectionTool } from "./replace-selection";

export function buildToolRegistry(
  db: LibSQLDatabase<Record<string, unknown>>,
  ctx: SkillRunContext,
  capture: (payload: WriteSectionPayload) => void,
) {
  const base = {
    read_note: createReadNoteTool({ db, noteId: ctx.noteId }),
    read_transcript: createReadTranscriptTool({ db, noteId: ctx.noteId }),
  };

  if (ctx.mode === "inline-rewrite") {
    return {
      ...base,
      replace_selection: createReplaceSelectionTool({
        capture,
        selectionText: ctx.selectionText ?? "",
      }),
    };
  }

  return {
    ...base,
    write_section: createWriteSectionTool({
      capture,
      mode: ctx.mode === "append-section" ? "append-section" : "replace-doc",
    }),
  };
}
