'use client';

import { Folder } from 'lucide-react';
import { SharedFolderIcon as SharedFolderGlyph } from './shared-folder-icon';
import { cn } from '../lib/utils';

/**
 * The one folder chip. A note row's folder, the note page's folder chip and the notes page's
 * folders strip all draw a folder through this, so a folder reads the same wherever you meet it.
 *
 * Two sizes. `xs` is the 22px chip that sits inside a note row beside its tags and on the note
 * page. `sm` is a target of its own on the folders strip, so it gets a little more height and
 * padding to be comfortable to hit, but the same outline, icon and type.
 *
 * Outlined, not filled: a filled chip is bg-muted + text-muted-foreground, which is how disabled
 * controls are drawn, so the folder NAME (real content) read as a placeholder. The outline is
 * --border, not --surface-raised: in light that token equals --background and the chip had no edge.
 */
export type FolderChipSize = 'xs' | 'sm';

export function folderChipClass(
  size: FolderChipSize,
  options: { interactive?: boolean; dashed?: boolean } = {}
): string {
  return cn(
    'inline-flex min-w-0 shrink-0 items-center border border-border font-medium',
    size === 'xs'
      ? 'h-[22px] gap-1 rounded-sm px-2 text-2xs'
      : 'h-7 gap-1.5 rounded-md px-2.5 text-xs',
    options.dashed ? 'border-dashed text-muted-foreground' : 'text-foreground',
    options.interactive && 'transition-colors hover:bg-surface-raised hover:text-foreground'
  );
}

interface FolderChipLabelProps {
  name: string;
  size?: FolderChipSize;
  /** Notes in the folder and everything under it; omitted where a count would be noise. */
  count?: number;
  /** The folder has people on it, or was shared with the viewer. */
  shared?: boolean;
  /** What the shared glyph says to assistive tech; required when `shared` can be true. */
  sharedLabel?: string;
  /** Caps the name; the chip itself never grows past its container. */
  nameClassName?: string;
}

/** The chip's content, for whatever element wraps it (a link, a button, a plain span). */
export function FolderChipLabel({
  name,
  size = 'xs',
  count,
  shared = false,
  sharedLabel,
  nameClassName,
}: FolderChipLabelProps) {
  const icon = cn(size === 'xs' ? 'size-3' : 'size-3.5', 'shrink-0 text-muted-foreground');
  return (
    <>
      <SharedFolderIcon shared={shared} className={icon} />
      {shared && sharedLabel ? <span className="sr-only">{sharedLabel}</span> : null}
      <span className={cn('truncate', nameClassName)}>{name}</span>
      {count !== undefined ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </>
  );
}

/**
 * The "+N" chip that ends an overflowing strip of folder chips or tag chips: the same shape as
 * the chips it stands in for, filled instead of outlined so it reads as a count, not an item.
 */
export const counterChipClass = cn(
  folderChipClass('sm'),
  'border-transparent bg-muted-foreground/10 text-muted-foreground'
);

/** The folder glyph, or the shared-folder one when the folder has people on it. */
export function SharedFolderIcon({ shared, className }: { shared: boolean; className?: string }) {
  return shared ? <SharedFolderGlyph className={className} /> : <Folder className={className} />;
}
