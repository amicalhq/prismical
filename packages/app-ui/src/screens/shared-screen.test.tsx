// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SharedScreen } from './shared-screen';

const state = vi.hoisted(() => ({
  notes: [] as {
    id: string;
    title: string;
    updatedAt: string;
    isOwner?: boolean;
    sharedByName?: string;
  }[],
  folders: [] as {
    id: string;
    name: string;
    parentId: string | null;
    createdAt: string;
    isOwner?: boolean;
    sharedByName?: string;
  }[],
}));

vi.mock('@prismical/app-client', () => ({
  useNotes: () => ({ data: state.notes, isLoading: false }),
  useFolders: () => ({ data: state.folders, isLoading: false }),
}));
vi.mock('@prismical/app-i18n', () => ({
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
  formatApplicationLastMet: () => '3h',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}));
vi.mock('../shell/app-link', () => ({
  AppLink: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  state.notes = [];
  state.folders = [];
});
afterEach(cleanup);

it('lists the folders shared with me, roots only, above the notes, each linking into the folder', () => {
  state.folders = [
    { id: 'fld_mine', name: 'Mine', parentId: null, createdAt: '2026-01-01', isOwner: true },
    {
      id: 'fld_sales',
      name: 'Sales',
      parentId: null,
      createdAt: '2026-01-01',
      isOwner: false,
      sharedByName: 'Ada',
    },
  ];
  state.notes = [
    { id: 'nt_1', title: 'Pipeline', updatedAt: '2026-01-01', isOwner: false, sharedByName: 'Bo' },
  ];
  render(<SharedScreen />);
  const links = screen.getAllByRole('link');
  expect(links.map(link => link.getAttribute('href'))).toEqual([
    '/notes?folder=fld_sales',
    '/notes/nt_1',
  ]);
  expect(screen.getByText('shared.sharedBy:Ada')).toBeTruthy();
  expect(screen.queryByText('Mine')).toBeNull();
});

it('shows the empty state only when neither folders nor notes were shared', () => {
  state.folders = [
    { id: 'fld_sales', name: 'Sales', parentId: null, createdAt: '2026-01-01', isOwner: false },
  ];
  render(<SharedScreen />);
  expect(screen.queryByText('shared.emptyTitle')).toBeNull();
  expect(screen.getByText('shared.sharedBy:shared.someone')).toBeTruthy();
});
