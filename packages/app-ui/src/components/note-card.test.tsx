// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@prismical/app-contracts';
import { NoteCard } from './note-card';

// The row's whole job is deciding what to draw and where, so the data hooks are the only things
// mocked: the chips, the budgets and the layout branches are the code under test.
const { folders, tags, noteEvents, calendarEvents } = vi.hoisted(() => ({
  folders: { current: [] as { id: string; name: string }[] },
  tags: { current: [] as { id: string; name: string; color: string | null }[] },
  noteEvents: { current: [] as { eventKey: string; eventId?: string; title: string }[] },
  calendarEvents: { current: [] as { id: string; title: string; calendarColor?: string }[] },
}));

vi.mock('@prismical/app-client', () => ({
  useFolders: () => ({ data: folders.current }),
  useTags: () => ({ data: tags.current }),
  useNoteEvents: () => ({ data: noteEvents.current }),
  useCalendarEvents: () => ({ data: calendarEvents.current }),
}));
vi.mock('@prismical/app-i18n', () => ({
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
  formatApplicationTimeAgoShort: () => '3h',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { count: number }) => (args ? `${key}:${args.count}` : key),
  }),
}));
vi.mock('../shell/app-link', () => ({
  AppLink: ({ children, ...rest }: React.ComponentProps<'a'>) => <a {...rest}>{children}</a>,
}));

function makeNote(patch: Partial<Note> = {}): Note {
  return {
    id: 'note_1',
    title: 'Quarterly planning',
    starred: false,
    tagIds: [],
    updatedAt: '2026-09-09T12:00:00.000Z',
    preview: '',
    body: '',
    ...patch,
  };
}

/** The line the tags share with the note's name, as opposed to the metadata line beneath it. */
function titleLine(): HTMLElement {
  return screen.getByText('Quarterly planning').parentElement as HTMLElement;
}

beforeEach(() => {
  folders.current = [];
  tags.current = [];
  noteEvents.current = [];
  calendarEvents.current = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('links the whole row to the note and names it for assistive tech', () => {
  render(<NoteCard note={makeNote()} />);
  expect(screen.getByRole('link', { name: 'Quarterly planning' })).toHaveProperty(
    'href',
    expect.stringContaining('/notes/note_1')
  );
});

describe('tags', () => {
  beforeEach(() => {
    tags.current = [
      { id: 't1', name: 'Ideas', color: '#a78bfa' },
      { id: 't2', name: 'Personal', color: '#34d399' },
      { id: 't3', name: 'Research', color: '#60a5fa' },
      { id: 't4', name: 'Archive', color: '#f87171' },
      { id: 't5', name: 'Later', color: '#fbbf24' },
    ];
  });

  // Tags name what the note is about, so they belong beside the name rather than under it.
  it('draws the tags on the title line, not the metadata line', () => {
    render(<NoteCard note={makeNote({ tagIds: ['t1', 't2'] })} />);
    expect(within(titleLine()).getByText('Ideas')).toBeTruthy();
    expect(within(titleLine()).getByText('Personal')).toBeTruthy();
  });

  it('counts the tags past the budget instead of drawing them', () => {
    render(<NoteCard note={makeNote({ tagIds: ['t1', 't2', 't3', 't4', 't5'] })} />);
    expect(screen.getAllByText(/^(Ideas|Personal|Research)$/)).toHaveLength(3);
    expect(screen.queryByText('Archive')).toBeNull();
    expect(screen.getByRole('button', { name: 'notes.list.moreTags:2' })).toBeTruthy();
  });

  it('draws no counter when every tag fits', () => {
    render(<NoteCard note={makeNote({ tagIds: ['t1', 't2', 't3'] })} />);
    expect(screen.queryByRole('button', { name: /moreTags/ })).toBeNull();
  });

  // tagIds is in note-tag link order; a tag the row cannot resolve is skipped, not rendered blank.
  it('skips a tag id that resolves to nothing', () => {
    render(<NoteCard note={makeNote({ tagIds: ['t1', 'gone'] })} />);
    expect(screen.getByText('Ideas')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /moreTags/ })).toBeNull();
  });
});

describe('meetings and folder', () => {
  it('shows one meeting and counts the rest', () => {
    noteEvents.current = [
      { eventKey: 'k1', eventId: 'e1', title: 'Gold Cup Parade' },
      { eventKey: 'k2', title: 'Royal Regatta' },
      { eventKey: 'k3', title: 'Standup' },
    ];
    calendarEvents.current = [{ id: 'e1', title: 'Gold Cup Parade', calendarColor: '#f0f' }];
    render(<NoteCard note={makeNote()} />);
    expect(screen.getByText('Gold Cup Parade')).toBeTruthy();
    expect(screen.queryByText('Royal Regatta')).toBeNull();
    expect(screen.getByRole('button', { name: 'notes.list.moreMeetings:2' })).toBeTruthy();
  });

  // A link carries its own snapshot of the meeting, which is what a collaborator holding no copy
  // of the invite renders from.
  it('falls back to the link title when the calendar row is not ours', () => {
    noteEvents.current = [{ eventKey: 'k1', eventId: 'e-unknown', title: 'Their meeting' }];
    render(<NoteCard note={makeNote()} />);
    expect(screen.getByText('Their meeting')).toBeTruthy();
  });

  it('shows the folder by its own name', () => {
    folders.current = [{ id: 'f1', name: 'Meetings' }];
    render(<NoteCard note={makeNote({ folderId: 'f1' })} />);
    expect(screen.getByText('Meetings')).toBeTruthy();
  });

  // The metadata line is where a note came from; tags alone do not earn a second line.
  it('draws no metadata line for a note carrying only tags', () => {
    tags.current = [{ id: 't1', name: 'Ideas', color: '#a78bfa' }];
    const { container } = render(<NoteCard note={makeNote({ tagIds: ['t1'] })} />);
    const column = screen.getByText('Quarterly planning').closest('.flex-1') as HTMLElement;
    expect(column.children).toHaveLength(1);
    expect(container.textContent).toContain('Ideas');
  });
});

// jsdom computes no layout, so the narrow-row behaviour these classes produce cannot be asserted
// by measuring. They are asserted directly because the failure they guard against is severe and
// silent: with a `shrink-0` tag group and a `min-w-0` title, a 340px column squeezed the title to
// zero width — the note lost its visible name — and pushed the star and the age outside the row,
// breaking the date column. Verified by measurement in a real browser; this is the regression net.
describe('narrow rows', () => {
  it('keeps a floor under the title and lets the tags give way', () => {
    tags.current = [{ id: 't1', name: 'Ideas', color: '#a78bfa' }];
    render(<NoteCard note={makeNote({ tagIds: ['t1'] })} />);
    const title = screen.getByText('Quarterly planning');
    const tagGroup = title.nextElementSibling as HTMLElement;

    // A floor, so the title can truncate but never vanish.
    expect(title.className).toContain('min-w-[4ch]');
    expect(title.className).not.toContain('min-w-0');

    // Shrinkable and clipping, so the chips yield before the row's trailing edge does.
    expect(tagGroup.className).toContain('min-w-0');
    expect(tagGroup.className).toContain('overflow-hidden');
    expect(tagGroup.className).not.toContain('shrink-0');
  });
});

describe('favorite star', () => {
  it('draws the star only on a favorited note', () => {
    const { rerender } = render(<NoteCard note={makeNote({ starred: false })} />);
    expect(screen.queryByLabelText('navigation.collections.favorited')).toBeNull();
    rerender(<NoteCard note={makeNote({ starred: true })} />);
    expect(screen.getByLabelText('navigation.collections.favorited')).toBeTruthy();
  });

  // An indicator, not a control: the row's whole surface is the link to the note, and a stray
  // click on a control here would drop a favorite with nothing in the row to undo it.
  it('is not clickable', () => {
    render(<NoteCard note={makeNote({ starred: true })} />);
    const star = screen.getByLabelText('navigation.collections.favorited');
    expect(star.tagName).toBe('SPAN');
    expect(star.closest('button')).toBeNull();
  });
});
