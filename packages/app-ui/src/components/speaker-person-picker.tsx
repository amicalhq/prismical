import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { usePeople, useSpeakerCandidates } from '@prismical/app-client';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { getInitials } from '../ui/user-avatar';

/** One row the picker can hand back: a person in the org's directory. */
export interface PickablePerson {
  id: string;
  email: string;
  name: string | null;
  company?: { name: string } | null;
}

/**
 * The "Tag person" picker: one searchable list, the recording's meeting participants pinned on
 * top, then everyone the caller has met. Participants are filtered here (a handful of rows);
 * the directory search runs server-side, debounced per keystroke. No "create person": a person
 * needs an email, so someone who is not in People gets a plain rename instead.
 */
export function SpeakerPersonPicker({
  recordingId,
  currentPersonId,
  onPick,
}: {
  recordingId: string;
  /** The speaker's current link, shown checked. */
  currentPersonId?: string | null;
  onPick: (person: PickablePerson) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState('');
  const search = useDebounced(query.trim(), 200);
  const candidates = useSpeakerCandidates(recordingId);
  const people = usePeople({ search: search || undefined });

  const needle = query.trim().toLowerCase();
  const matches = (p: PickablePerson) =>
    !needle ||
    (p.name ?? '').toLowerCase().includes(needle) ||
    p.email.toLowerCase().includes(needle);
  const participants = (candidates.data ?? []).filter(matches);
  const pinned = new Set(participants.map(p => p.id));
  const others = (people.data ?? []).filter(p => !pinned.has(p.id));
  const empty = participants.length === 0 && others.length === 0;

  const row = (p: PickablePerson) => (
    <CommandItem
      key={p.id}
      value={p.id}
      onSelect={() => onPick(p)}
      className="flex items-center gap-2"
      data-selected-person={p.id === currentPersonId ? 'true' : undefined}
    >
      <Avatar size="sm">
        <AvatarFallback className="text-2xs font-semibold">{getInitials(p.name, p.email)}</AvatarFallback>
      </Avatar>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{p.name ?? p.email}</span>
        <span className="truncate text-xs text-muted-foreground">
          {p.name ? p.email : (p.company?.name ?? '')}
          {p.name && p.company?.name ? ` · ${p.company.name}` : ''}
        </span>
      </span>
    </CommandItem>
  );

  return (
    <Command shouldFilter={false}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('recording.panel.searchPeople')}
        aria-label={t('recording.panel.searchPeople')}
      />
      <CommandList>
        {empty && !candidates.isPending && !people.isPending ? (
          <CommandEmpty>{t('recording.panel.noPeople')}</CommandEmpty>
        ) : null}
        {participants.length > 0 ? (
          <CommandGroup heading={t('recording.panel.inThisMeeting')}>
            {participants.map(row)}
          </CommandGroup>
        ) : null}
        {others.length > 0 ? (
          <CommandGroup heading={t('recording.panel.allPeople')}>{others.map(row)}</CommandGroup>
        ) : null}
      </CommandList>
    </Command>
  );
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
