/**
 * The note-side input a skill run feeds the model. Storage adapters assemble
 * this shape after applying their access checks.
 */

/**
 * Factual signals for the voice-note versus meeting judgement: capture mode,
 * the diarized speaker count in `recording.meta.detectedSpeakerCount`, and the linked calendar
 * event (title + attendee COUNT only — attendee emails stay out of the prompt).
 */
export interface SkillRunContext {
  captureMode?: string;
  detectedSpeakerCount?: number;
  /** null = definitively no linked event (itself a signal, distinct from "unknown"). */
  linkedEvent: { title: string; attendeeCount?: number } | null;
}

export interface SkillNoteInput {
  noteId: string;
  title: string;
  noteText: string;
  transcript?: string;
  /** The recording the transcript was scoped to, when a `recordingId` was passed. */
  recordingId?: string;
  /** Present only for transcript-consuming runs — see SkillRunContext. */
  context?: SkillRunContext;
}
