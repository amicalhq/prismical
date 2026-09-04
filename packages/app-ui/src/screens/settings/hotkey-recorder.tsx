'use client';

import * as React from 'react';
import { Button } from '../../ui/button';
import { cn } from '../../lib/utils';
import { acceleratorChips } from '../../lib/shortcuts';
import { Kbd } from '../../ui/kbd';
import { useTranslation } from 'react-i18next';

// Click → capture the next chord as an Electron accelerator. The control
// lives in Settings → Shortcuts, the single place shortcuts are configured.

// Electron accelerator names for the non-printable keys we accept. Letters and
// digits come from `event.code` (NOT `event.key`: Alt/Shift mutate the key
// value — ⌥⇧N reports "ˇ" — while the physical code stays stable).
const CODE_TO_ACCELERATOR: Readonly<Record<string, string>> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

function eventToAccelerator(event: React.KeyboardEvent, isMac: boolean): string | null {
  // A GLOBAL shortcut needs a real (non-shift) modifier — a bare letter would
  // swallow normal typing system-wide.
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  const { code } = event;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (code in CODE_TO_ACCELERATOR) key = CODE_TO_ACCELERATOR[code] ?? null;
  if (key === null) return null;
  const modifiers = [
    // Electron's `Command` is macOS-only; the meta/Windows key elsewhere is
    // `Super`. Persisting `Command` off-mac would register as nothing.
    event.metaKey ? (isMac ? 'Command' : 'Super') : null,
    event.ctrlKey ? 'Control' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
  ].filter((value): value is string => value !== null);
  return [...modifiers, key].join('+');
}

/**
 * Escape cancels, Delete/Backspace disables (accelerator ''). While listening
 * the CURRENT registration is suspended (the hotkey is written to '' and
 * restored on cancel/blur) — otherwise main's live globalShortcut swallows the
 * very chord being re-recorded before the renderer ever sees it. Registration
 * conflicts with OTHER apps remain main's problem (it logs and leaves the
 * hotkey off).
 */
export function HotkeyRecorder({
  id,
  value,
  isMac,
  label,
  onChange,
}: {
  id: string;
  value: string;
  isMac: boolean;
  label: string;
  onChange: (accelerator: string) => void;
}) {
  const { t } = useTranslation();
  const [listening, setListening] = React.useState(false);
  const suspendedRef = React.useRef<string | null>(null);

  const beginListening = () => {
    if (listening) return;
    suspendedRef.current = value;
    if (value !== '') onChange(''); // release the OS registration while recording
    setListening(true);
  };
  const cancelListening = () => {
    if (!listening) return;
    const prior = suspendedRef.current;
    suspendedRef.current = null;
    if (prior !== null && prior !== '') onChange(prior); // restore
    setListening(false);
  };
  const commit = (accelerator: string) => {
    suspendedRef.current = null;
    onChange(accelerator);
    setListening(false);
  };

  return (
    <Button
      id={id}
      variant="outline"
      size="sm"
      // Dashed frame around the key caps: the read-only rows on this screen are
      // bare caps, so the frame is what says "this one you can change". Solid on
      // hover/focus, and accent-filled while listening.
      className={cn(
        // Width hugs the caps — a fixed min-width left an empty dashed gutter.
        'h-auto gap-1 border-dashed px-2 py-1',
        'hover:border-solid hover:bg-accent',
        listening && 'border-solid border-ring bg-accent'
      )}
      title={t('settings.shortcuts.recorder.title')}
      aria-label={label}
      onClick={beginListening}
      onBlur={cancelListening}
      onKeyDown={event => {
        if (!listening) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          cancelListening();
          return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          commit('');
          return;
        }
        const accelerator = eventToAccelerator(event, isMac);
        if (accelerator !== null) commit(accelerator);
      }}
    >
      {/* One <kbd> per key (⌥ ⇧ N), matching the read-only rows above. */}
      {listening ? (
        <span className="text-xs text-muted-foreground">
          {t('settings.shortcuts.recorder.pressKeys')}
        </span>
      ) : value === '' ? (
        <span className="text-xs text-muted-foreground">
          {t('settings.shortcuts.recorder.disabled')}
        </span>
      ) : (
        acceleratorChips(value, isMac).map((key, index) => <Kbd key={`${key}-${index}`}>{key}</Kbd>)
      )}
    </Button>
  );
}
