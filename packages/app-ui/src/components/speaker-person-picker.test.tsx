// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

// cmdk measures its list with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);
Element.prototype.scrollIntoView = () => {};

const state = {
  candidates: [] as Array<{ id: string; email: string; name: string | null; company: null }>,
  people: [] as Array<{ id: string; email: string; name: string | null; company: null }>,
  lastSearch: undefined as string | undefined,
};
vi.mock('@prismical/app-client', () => ({
  useSpeakerCandidates: () => ({ data: state.candidates, isPending: false }),
  usePeople: (opts: { search?: string }) => {
    state.lastSearch = opts.search;
    return { data: state.people, isPending: false };
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { SpeakerPersonPicker } from './speaker-person-picker';

afterEach(() => {
  cleanup();
  state.candidates = [];
  state.people = [];
  state.lastSearch = undefined;
});

const person = (id: string, name: string | null, email: string) => ({ id, name, email, company: null });

it('pins meeting participants above the directory and de-duplicates them', () => {
  state.candidates = [person('prs_a', 'Ana Ruiz', 'ana@example.com')];
  state.people = [person('prs_a', 'Ana Ruiz', 'ana@example.com'), person('prs_b', 'Bo Chen', 'bo@example.com')];
  render(<SpeakerPersonPicker recordingId="rec_1" onPick={vi.fn()} />);
  const groups = screen.getAllByRole('group');
  expect(groups.map(g => g.getAttribute('aria-label') ?? g.textContent)).toHaveLength(2);
  expect(within(groups[0]!).getByText('Ana Ruiz')).toBeTruthy();
  expect(within(groups[1]!).getByText('Bo Chen')).toBeTruthy();
  expect(within(groups[1]!).queryByText('Ana Ruiz')).toBeNull();
});

it('hands the picked person back', () => {
  const onPick = vi.fn();
  state.people = [person('prs_b', 'Bo Chen', 'bo@example.com')];
  render(<SpeakerPersonPicker recordingId="rec_1" onPick={onPick} />);
  fireEvent.click(screen.getByText('Bo Chen'));
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'prs_b', name: 'Bo Chen' }));
});

it('filters participants locally and shows the empty state when nothing matches', () => {
  state.candidates = [person('prs_a', 'Ana Ruiz', 'ana@example.com')];
  render(<SpeakerPersonPicker recordingId="rec_1" onPick={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('recording.panel.searchPeople'), { target: { value: 'zzz' } });
  expect(screen.queryByText('Ana Ruiz')).toBeNull();
  expect(screen.getByText('recording.panel.noPeople')).toBeTruthy();
});
