'use client';

import type * as React from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { SharedFolderIcon } from './shared-folder-icon';
import { cn } from '../lib/utils';
import { useTranslation } from 'react-i18next';

interface FolderDisclosureProps {
  /** A folder with nothing inside is not a control — it keeps its icon and does not react. */
  hasChildren: boolean;
  open: boolean;
  /** The folder's name, for the toggle's label. */
  name: string;
  onToggle: () => void;
  /** Draw the people mark on the icon: the folder has members, or came from someone else. */
  shared?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * The folder icon, doubling as the expand/collapse control: closed while collapsed, open once
 * expanded. No chevron parked beside it — the folder is the thing being opened, so the icon says
 * so directly, and no column is drawn that stays blank on every folder holding nothing.
 *
 * On hover it BECOMES a chevron, and takes a fill of its own. At rest nothing marked this as a
 * separate target: the row highlights as one piece, so the icon looked like part of the link and
 * the toggle went unfound. Answering on hover keeps the resting row quiet while saying plainly,
 * at the moment a pointer is over it, that this particular spot does something else — the same
 * bargain the row's ... menu strikes.
 *
 * The folder glyphs sit only a few pixels apart at this size, so the state never rests on them
 * alone: the children indented underneath say it louder.
 *
 * Both branches occupy the SAME box, whether or not they are a button. Rendering the plain icon
 * without the button's padding left leaf rows' icons four pixels off the ones that could be
 * expanded, and a column of icons reads its own misalignment immediately.
 */
export function FolderDisclosure({
  hasChildren,
  open,
  name,
  onToggle,
  shared = false,
  className,
  style,
}: FolderDisclosureProps) {
  const { t } = useTranslation();
  const box = 'flex size-6 shrink-0 items-center justify-center rounded';
  if (!hasChildren) {
    return (
      <span className={cn(box, 'text-muted-foreground', className)} style={style}>
        <Glyph Icon={Folder} shared={shared} />
      </span>
    );
  }
  const Icon = open ? FolderOpen : Folder;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={event => {
        // The row around this is a link; toggling must not follow it.
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-expanded={open}
      aria-label={open ? t('folders.collapse', { name }) : t('folders.expand', { name })}
      className={cn(
        box,
        // Its own fill, over the row's: --sidebar-accent is a 5% wash, so the
        // two together read as a slightly deeper square exactly under the
        // pointer - enough to bound the target without shouting.
        'group/disclosure cursor-pointer text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
        className
      )}
      style={style}
    >
      {/* Swapped in CSS rather than on a hover state: the pointer leaving mid-render
          would otherwise strand the wrong glyph. Keyboard focus gets the same answer. */}
      <span className="group-focus-visible/disclosure:hidden group-hover/disclosure:hidden">
        <Glyph Icon={Icon} shared={shared} />
      </span>
      <Chevron
        aria-hidden="true"
        className="hidden size-4 group-focus-visible/disclosure:block group-hover/disclosure:block"
      />
    </button>
  );
}

/** The folder glyph; the shared-folder one while closed and shared (open already says open). */
function Glyph({ Icon, shared }: { Icon: typeof Folder; shared: boolean }) {
  if (shared && Icon === Folder) return <SharedFolderIcon className="size-4" />;
  return <Icon className="size-4" />;
}
