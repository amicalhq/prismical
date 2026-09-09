import type { UIMessage } from 'ai';
import type { Skill } from '@prismical/app-contracts';
import { parseSources } from './sources';
export { parseSources } from './sources';

export type AskContextKind = 'note' | 'folder' | 'tag';

/**
 * The skills offered as Ask AI suggestions: enabled skills whose `config.surface` includes `"ask"`.
 * Preserves the input order (the list hook already sorts). A skill's `body` is the prompt sent to
 * `/me/ask` when its suggestion is tapped; `name` is the pill label.
 *
 * Scope: `single-note` skills (prompts about the note in focus, e.g. "Summarize this note") only show
 * when a note is open; `multi-note` skills (the default) show everywhere. Pass `hasNote` to say whether
 * a note is currently in focus.
 */
export function askSkills(skills: Skill[], opts?: { hasNote?: boolean }): Skill[] {
  const hasNote = opts?.hasNote ?? false;
  return skills.filter(
    s =>
      s.enabled &&
      s.config.surface.includes('ask') &&
      (hasNote || s.config.askScope !== 'single-note')
  );
}

export interface AskContextItem {
  kind: AskContextKind;
  id: string;
  label: string;
}

export interface AskScope {
  noteIds?: string[];
  folderIds?: string[];
  tagIds?: string[];
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/** Bucket context chips into the backend scope shape. Empty selection ⇒ undefined (global). */
export function contextToScope(items: AskContextItem[]): AskScope | undefined {
  if (items.length === 0) return undefined;
  const pick = (k: AskContextKind) => uniq(items.filter(i => i.kind === k).map(i => i.id));
  const noteIds = pick('note');
  const folderIds = pick('folder');
  const tagIds = pick('tag');
  const scope: AskScope = {};
  if (noteIds.length) scope.noteIds = noteIds;
  if (folderIds.length) scope.folderIds = folderIds;
  if (tagIds.length) scope.tagIds = tagIds;
  return scope;
}

/**
 * Split an answer body (already stripped of its `Sources:` line by {@link parseSources}) into the
 * rendered body + the model's suggested follow-up questions. The backend — when the client opts in
 * via `suggestFollowups` — instructs the model to put a `Follow-ups: q1 | q2` line directly above
 * `Sources:`, so after the Sources strip it is the LAST non-empty line. Only that position is
 * treated as suggestions (a mid-answer "Follow-ups:" mention stays body text). Pipe-separated
 * (questions may contain commas), deduped, capped at 3; a bare `Follow-ups:` line is stripped and
 * yields none.
 */
export function parseFollowups(body: string): { body: string; followups: string[] } {
  const lines = body.split(/\r?\n/);
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx]!.trim() === '') lastIdx--;
  const last = lastIdx >= 0 ? lines[lastIdx]! : '';
  // Preserve examples inside an unfinished fenced code block.
  let fence: string | undefined;
  for (const line of lines.slice(0, lastIdx)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim())
      fence = undefined;
  }
  if (fence) return { body, followups: [] };
  const m = /^Follow-ups?:\s*(.*)$/i.exec(last.trim());
  // Some providers append the trailer to the final sentence instead of starting a new line.
  // Require a sentence boundary and multiple pipe-separated suggestions for this fallback.
  const inline = m ? null : /^(.+[.!?])\s+Follow-ups?:\s*([^|]+\|.+)$/i.exec(last.trim());
  if (!m && !inline) return { body, followups: [] };
  const followups = [
    ...new Set(
      (m?.[1] ?? inline![2]!)
        .split('|')
        .map(s => s.trim())
        .filter(s => s.length > 0)
    ),
  ].slice(0, 3);
  return {
    body: [...lines.slice(0, lastIdx), ...(inline ? [inline[1]!] : [])].join('\n').trimEnd(),
    followups,
  };
}

const TRAILER_MARKERS = ['sources:', 'follow-ups:', 'follow-up:'];

/**
 * While a turn is still streaming, the trailer block arrives token by token — a half-written
 * `Sources` (no colon yet) matches neither parser and would flash the fully-formed `Follow-ups:`
 * line above it as body text for a few frames. Repeatedly drop a trailing line that is a prefix
 * of a marker (half-written) or starts with one (complete) — streaming renders only, so a real
 * prose line that happens to collide merely hides until the next token proves it out.
 */
function stripStreamingTrailers(text: string): string {
  const lines = text.split(/\r?\n/);
  let last = lines.length - 1;
  for (let guard = 0; guard < 4; guard += 1) {
    while (last >= 0 && lines[last]!.trim() === '') last--;
    if (last < 0) break;
    const probe = lines[last]!.trim().toLowerCase();
    const markerish = TRAILER_MARKERS.some(m => m.startsWith(probe) || probe.startsWith(m));
    if (!markerish) break;
    last -= 1;
  }
  return lines
    .slice(0, last + 1)
    .join('\n')
    .trimEnd();
}

/**
 * The one-stop answer parse for Ask renderers: body + cited noteIds + follow-up suggestions.
 * Order-tolerant — the prompt demands `Follow-ups:` directly above the final `Sources:` line, but
 * a model that inverts the two trailers must not cost the user their citations, so Sources is
 * parsed both before and after the follow-ups strip and the ids merged. Pass `streaming` while
 * the turn is still arriving to also suppress half-written trailer lines.
 */
export function parseAskAnswer(
  text: string,
  opts?: { streaming?: boolean }
): { body: string; noteIds: string[]; followups: string[] } {
  const input = opts?.streaming ? stripStreamingTrailers(text) : text;
  const first = parseSources(input);
  const fu = parseFollowups(first.body);
  const second = parseSources(fu.body);
  return {
    body: second.body,
    noteIds: [...new Set([...first.noteIds, ...second.noteIds])],
    followups: fu.followups,
  };
}

/** Concatenate the text parts of a UIMessage (ignoring tool/step parts). */
export function uiMessageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map(p => p.text)
    .join('');
}
