import { isValidPrefixedId } from '@prismical/id';

/**
 * Split the model's answer into the rendered body + cited noteIds. The backend instructs the model
 * to END the answer with `Sources: <id>, <id>`; we only treat such a line as citations when it is
 * the LAST non-empty line, so a mid-answer mention of "Sources:" is left untouched. Cited ids are
 * deduped and must be shaped like note ids (`nt_…`) — the model occasionally emits prose ("none",
 * a trailing period) or, mid-stream, a truncated token; neither should become a note link.
 */
export function parseSources(text: string): { body: string; noteIds: string[] } {
  // Split on CRLF or LF so a `\r`-terminated final line doesn't leave `\r` on the parsed ids.
  const lines = text.split(/\r?\n/);
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx]!.trim() === '') lastIdx--;
  const last = lastIdx >= 0 ? lines[lastIdx]! : '';
  // `.*` (not `.+`) so a BARE `Sources:` line — which the model emits when it used no notes — is
  // matched and stripped too, rather than left dangling in the rendered answer.
  const m = /^Sources:\s*(.*)$/i.exec(last.trim());
  if (!m) return { body: text, noteIds: [] };
  // A copied code example is content, including an unfinished fence while streaming.
  let fence: string | undefined;
  for (const line of lines.slice(0, lastIdx)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = marker[1];
    else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim())
      fence = undefined;
  }
  if (fence) return { body: text, noteIds: [] };
  const noteIds = [
    ...new Set(
      m[1]!
        .split(',')
        // Models sometimes decorate ids (backticks, a sentence-final period) — strip common
        // wrapping punctuation before validating so a real citation isn't dropped for it.
        .map(s =>
          s
            .trim()
            .replace(/^[`'"([]+/, '')
            .replace(/[`'").,;:\]]+$/, '')
        )
        .filter(s => isValidPrefixedId('note', s))
    ),
  ];
  const body = lines.slice(0, lastIdx).join('\n').trimEnd();
  return { body, noteIds };
}
