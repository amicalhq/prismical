'use client';

import { useNavigation } from '@prismical/app-client';
import { Plus } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { useCreateNote } from '@prismical/app-client';
import { DOCK_PILL_CHROME } from './dock-chrome';
import { useTranslation } from 'react-i18next';

// The "New note" face of the bottom dock, shown on every page that ISN'T a note
// (where the dock instead morphs into the recording unit). It is icon-only —
// the tooltip carries the words (the labelled pill read as a bar, not a dock
// unit, next to the icon-sized recording pill). Chrome (DOCK_PILL_CHROME)
// matches the units so the dock reads as one element as it morphs per page.
// Creates a loose note via core (server-generated id) and opens it; the body
// row is lazily created on first edit. (Web-only divergence: desktop only
// shows the dock on a note.)
export function NewNoteDock() {
  const { t } = useTranslation();
  const router = useNavigation();
  const createNote = useCreateNote();

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={createNote.isPending}
            onClick={() =>
              createNote.mutate(undefined, {
                onSuccess: note => router.push(`/notes/${note.id}`),
              })
            }
            aria-label={t('notes.newNote')}
            className={`
              ${DOCK_PILL_CHROME} w-[52px] cursor-pointer justify-center text-dock-ink-2
              hover:bg-dock-hover hover:text-dock-ink active:scale-95
              disabled:pointer-events-none disabled:opacity-60
            `}
          >
            <Plus className="size-[18px] shrink-0" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('notes.actions.createNew')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
