'use client';

import { cn } from '../lib/utils';
import { Kbd, KbdGroup } from '../ui/kbd';
import {
  getShortcut,
  shortcutChips,
  useIsApplePlatform,
  useIsModHeld,
  type ShortcutId,
} from '../lib/shortcuts';

/**
 * The ⌘-hint chip a nav item / search trigger renders next to its label. Reads
 * the combo from the shortcuts registry, so a chip can't drift
 * from the binding, and renders one shadcn `Kbd` cap per key so every surface
 * that advertises a shortcut looks the same.
 *
 * The chip only appears while the mod key is held: the keys are reference
 * material, not chrome, so they stay out of the sidebar until you reach for the
 * modifier. It unmounts rather than going transparent, so it can't be read by a
 * screen reader or hit-tested while hidden; nothing reflows, because the chip is
 * `ml-auto` at the end of its row.
 */
export function ShortcutHint({
  shortcut,
  className,
  kbdClassName,
}: {
  shortcut: ShortcutId;
  className?: string;
  /** Applied to each key cap — for surfaces whose own background is `muted`. */
  kbdClassName?: string;
}) {
  const isApple = useIsApplePlatform();
  const held = useIsModHeld();

  if (!held) return null;

  return (
    <KbdGroup className={cn('pointer-events-none ml-auto select-none', className)}>
      {shortcutChips(getShortcut(shortcut), isApple).map((key, index) => (
        <Kbd key={`${key}-${index}`} className={kbdClassName}>
          {key}
        </Kbd>
      ))}
    </KbdGroup>
  );
}
