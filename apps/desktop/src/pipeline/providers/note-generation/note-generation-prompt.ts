import type { NoteGenerationInput } from "./types";

export function buildNoteGenerationPrompt(input: NoteGenerationInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const noteContext = input.noteTitle
    ? `Current note title: ${input.noteTitle}`
    : "Current note title: Unnamed note";
  const eventContext = input.eventTitle
    ? `Related event title: ${input.eventTitle}`
    : undefined;

  const systemPrompt = `You generate clean Markdown meeting notes from transcripts.

Rules:
- Output Markdown only
- Do not wrap the answer in code fences
- Do not use horizontal rules
- Preserve factual meaning from the transcript
- Do not invent attendees, decisions, or action items that are not supported by the transcript
- Keep the output concise and scannable
- Use headings and bullet points only when they improve clarity
- Prefer bullets for action items, decisions, and risks
- If there are no clear action items, do not create a fake action items section
- Do not mention that the notes were AI-generated
- Do not mention transcript timestamps unless they are directly useful
- Start directly with the note body, not with commentary about what you are doing`;

  const contextLines = [noteContext, eventContext].filter(Boolean).join("\n");
  const userPrompt = `${contextLines}

Transcript:
${input.transcript}`;

  return {
    systemPrompt,
    userPrompt,
  };
}
