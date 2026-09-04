/**
 * A text field committed on blur/Enter (not per keystroke — each commit is an
 * IPC round trip that replaces a whole DeviceSettings record). The draft is
 * dropped once the committed value arrives back through the settings push.
 * Shared by the desktop-owned settings cards (transcription engine, AI
 * provider).
 */
import * as React from 'react';
import { Input } from '@prismical/app-ui/ui/input';

export function CommittedInput({
  id,
  value,
  placeholder,
  onCommit,
  list,
}: {
  id: string;
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
  /** A <datalist> id for suggestions. */
  list?: string;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [seen, setSeen] = React.useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(null);
  }
  return (
    <Input
      id={id}
      value={draft ?? value}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      list={list}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
      }}
      onKeyDown={event => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
