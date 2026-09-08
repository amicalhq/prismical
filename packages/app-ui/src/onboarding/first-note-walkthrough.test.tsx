// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { readWalkthrough, walkthroughKey } from './state';
const m = vi.hoisted(() => ({
  signupAt: new Date().toISOString() as string | undefined,
  pathname: '/home',
  replace: vi.fn(),
  platform: 'web',
  user: 'a',
  org: 'org' as string | null,
  ready: true,
  notes: [] as { id: string }[],
  push: vi.fn(),
  celebrate: vi.fn(),
  capture: vi.fn(),
  create: vi.fn(),
  candidate: undefined as { recordingId: string } | undefined,
}));
vi.mock('@prismical/app-client', () => ({
  EVENTS: {
    ONBOARDING_STARTED: 'onboarding_started',
    ONBOARDING_STEP_COMPLETED: 'onboarding_step_completed',
    ONBOARDING_COMPLETED: 'onboarding_completed',
    ONBOARDING_DISMISSED: 'onboarding_dismissed',
    ONBOARDING_ERROR: 'onboarding_error',
  },
  useAutoEnhanceStore: () => null,
  useCreateNote: () => ({ isPending: !m.ready, mutate: m.create }),
  useActiveAccountId: () => m.user,
  useActiveOrgId: () => m.org,
  useActiveSessionKey: () => m.user,
  useEnv: () => ({ platform: m.platform }),
  useNavigation: () => ({ push: m.push, replace: m.replace }),
  usePathname: () => m.pathname,
  useNotes: () => ({ isSuccess: m.ready, data: m.notes }),
  useSyncStore: () => (m.ready ? { partition: { accountSub: m.user, orgId: m.org } } : null),
  usePorts: () => ({
    assets: { resolve: (path: string) => path },
    analytics: { capture: m.capture },
    auth: {
      getSession: () => ({
        activeSub: m.user,
        accounts: [{ sub: m.user, activeOrgId: m.org, signupAt: m.signupAt }],
      }),
    },
  }),
  useSkillDiffStore: (selector: (s: unknown) => unknown) =>
    selector({ candidatesByNote: new Map([['note', m.candidate]]) }),
}));
vi.mock('./confetti', () => ({ celebrateOnboarding: m.celebrate }));
vi.mock('./anchored-tour', () => ({
  AnchoredTour: ({
    step,
    onContinue,
    onExit,
  }: {
    step: string;
    onContinue: () => void;
    onExit: () => void;
  }) => (
    <section aria-label="Tour">
      <span>{step}</span>
      <button onClick={onContinue}>Continue tour</button>
      <button onClick={onExit}>Skip tour</button>
    </section>
  ),
}));
const { FirstNoteWalkthroughProvider, FirstNoteWalkthroughReplay } =
  await import('./first-note-walkthrough');
const { useWalkthroughEvent } = await import('./context');
function Events() {
  const notify = useWalkthroughEvent();
  return (
    <>
      <button onClick={() => notify({ type: 'error', noteId: 'note', code: 'recording_failed' })}>
        Recording error
      </button>
      <button
        onClick={() => notify({ type: 'error', noteId: 'another', code: 'recording_failed' })}
      >
        Unrelated error
      </button>
      {(
        ['created', 'recording', 'ready-to-stop', 'recorded', 'review', 'kept', 'rejected'] as const
      ).map(type => (
        <button
          key={type}
          onClick={() => {
            m.pathname = '/notes/note';
            notify({ type, noteId: 'note', recordingId: 'r' });
          }}
        >
          {type}
        </button>
      ))}
    </>
  );
}
function Fixture({ enabled }: { enabled?: boolean } = {}) {
  return (
    <I18nextProvider i18n={createApplicationI18nSync()}>
      <FirstNoteWalkthroughProvider enabled={enabled}>
        <FirstNoteWalkthroughReplay />
        <Events />
      </FirstNoteWalkthroughProvider>
    </I18nextProvider>
  );
}
beforeEach(() => {
  window.localStorage.clear();
  m.signupAt = new Date().toISOString();
  m.pathname = '/home';
  m.replace.mockClear();
  m.platform = 'web';
  m.user = 'a';
  m.org = 'org';
  m.ready = true;
  m.notes = [];
  m.candidate = undefined;
  m.celebrate.mockClear();
  m.capture.mockReset();
});
afterEach(cleanup);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
it('waits for settled data and suppresses automatic tours for existing users', () => {
  m.ready = false;
  const view = render(<Fixture />);
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  m.ready = true;
  m.notes = [{ id: 'old' }];
  view.rerender(<Fixture />);
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
});
it('waits for actual dock creation instead of a tour Next click', () => {
  render(<Fixture />);
  click('Start walkthrough');
  click('Continue tour');
  expect(readWalkthrough(walkthroughKey('a'))?.status).toBe('offered');
  click('created');
  expect(screen.getByText('record')).toBeTruthy();
});
it('persists dismissal across reload and isolates accounts', () => {
  render(<Fixture />);
  click('Start walkthrough');
  click('Skip tour');
  cleanup();
  render(<Fixture />);
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  cleanup();
  m.user = 'b';
  render(<Fixture />);
  expect(screen.getByRole('button', { name: 'Start walkthrough' })).toBeTruthy();
});
it('walks actual success events, then shows use cases only once after Keep', () => {
  render(
    <React.StrictMode>
      <Fixture />
    </React.StrictMode>
  );
  click('Start walkthrough');
  click('created');
  click('recording');
  expect(screen.getByText('speak')).toBeTruthy();
  click('ready-to-stop');
  expect(screen.getByText('stop')).toBeTruthy();
  click('recorded');
  expect(screen.getByText('transcript')).toBeTruthy();
  click('Continue tour');
  expect(screen.getByText('enhance')).toBeTruthy();
  click('review');
  expect(screen.getByText('result')).toBeTruthy();
  click('Continue tour');
  expect(screen.getByRole('region', { name: 'Tour' }).textContent).toContain('review');
  expect(m.celebrate).not.toHaveBeenCalled();
  click('kept');
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('Meetings')).toBeTruthy();
  expect(screen.getByText('Lectures')).toBeTruthy();
  expect(screen.getByText('Voice notes')).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Need a hand? Read the docs' }).getAttribute('href')
  ).toBe('https://prismical.ai/docs');
  expect(screen.queryByRole('link', { name: /macOS|iOS|Download/ })).toBeNull();
  expect(m.celebrate).toHaveBeenCalledTimes(1);
  expect(m.capture.mock.calls.filter(([event]) => event === 'onboarding_started')).toHaveLength(1);
  expect(
    m.capture.mock.calls
      .filter(([event]) => event === 'onboarding_step_completed')
      .map(([, props]) => props.step)
  ).toEqual(['create', 'record', 'speak', 'stop', 'transcript', 'enhance', 'result', 'review']);
  expect(m.capture.mock.calls.filter(([event]) => event === 'onboarding_completed')).toHaveLength(
    1
  );
  click('Continue to my note');
  click('kept');
  expect(m.capture.mock.calls.filter(([event]) => event === 'onboarding_completed')).toHaveLength(
    1
  );
  expect(m.celebrate).toHaveBeenCalledTimes(1);
  cleanup();
  render(<Fixture />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
});
it('allows rejection and another Enhance without reporting completion', () => {
  render(<Fixture />);
  click('Start walkthrough');
  click('created');
  click('recording');
  click('recorded');
  click('review');
  click('rejected');
  expect(screen.getByText('enhance')).toBeTruthy();
  expect(m.celebrate).not.toHaveBeenCalled();
});
it('restarts only through an explicit sidebar action and retires at three notes', () => {
  m.notes = [{ id: 'one' }];
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: /Getting started/ }));
  expect(screen.getByText('create')).toBeTruthy();
  cleanup();
  m.notes = [{ id: '1' }, { id: '2' }, { id: '3' }];
  render(<Fixture />);
  expect(screen.queryByRole('button', { name: /Getting started/ })).toBeNull();
  cleanup();
  m.notes = [];
  render(<Fixture />);
  expect(screen.queryByRole('button', { name: /Getting started/ })).toBeNull();
});
it('does not leak active progress to another org and observes cross-tab dismissal', () => {
  const view = render(<Fixture />);
  click('Start walkthrough');
  click('created');
  m.org = 'other';
  view.rerender(<Fixture />);
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  m.org = 'org';
  m.notes = [{ id: 'note' }];
  view.rerender(<Fixture />);
  expect(screen.getByText('record')).toBeTruthy();
  act(() => {
    window.localStorage.setItem(walkthroughKey('a'), JSON.stringify({ status: 'dismissed' }));
    window.dispatchEvent(new StorageEvent('storage', { key: walkthroughKey('a') }));
  });
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
});
it('supports an explicit Electron opt-in without enabling it by default', () => {
  m.platform = 'desktop';
  render(<Fixture />);
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  cleanup();
  render(<Fixture enabled />);
  expect(screen.getByRole('button', { name: 'Start walkthrough' })).toBeTruthy();
});

it('resumes a saved tour on its note and never spotlights another route', () => {
  m.notes = [{ id: 'note' }];
  window.localStorage.setItem(
    walkthroughKey('a'),
    JSON.stringify({ status: 'active', orgId: 'org', noteId: 'note', step: 'record' })
  );
  const view = render(<Fixture />);
  expect(m.replace).toHaveBeenCalledWith('/notes/note');
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  m.pathname = '/notes/note';
  view.rerender(<Fixture />);
  expect(screen.getByText('record')).toBeTruthy();
  m.pathname = '/notes/another';
  view.rerender(<Fixture />);
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  expect(m.replace).toHaveBeenCalledTimes(1);
});

it('reports scoped errors without advancing, and records an exit separately from completion', () => {
  render(<Fixture />);
  click('Start walkthrough');
  click('created');
  click('Unrelated error');
  expect(m.capture.mock.calls.filter(([event]) => event === 'onboarding_error')).toHaveLength(0);
  click('Recording error');
  expect(m.capture).toHaveBeenCalledWith(
    'onboarding_error',
    expect.objectContaining({ step: 'record', code: 'recording_failed' })
  );
  expect(screen.getByText('record')).toBeTruthy();
  click('Skip tour');
  expect(m.capture).toHaveBeenCalledWith(
    'onboarding_dismissed',
    expect.objectContaining({ step: 'record' })
  );
  expect(m.capture.mock.calls.filter(([event]) => event === 'onboarding_completed')).toHaveLength(
    0
  );
});
it('does not let an analytics failure block the real action', () => {
  m.capture.mockImplementation(() => {
    throw new Error('analytics unavailable');
  });
  render(<Fixture />);
  click('Start walkthrough');
  click('created');
  expect(screen.getByText('record')).toBeTruthy();
});

it('dismisses a saved tour whose note was deleted instead of opening a missing note', () => {
  window.localStorage.setItem(
    walkthroughKey('a'),
    JSON.stringify({ status: 'active', orgId: 'org', noteId: 'deleted', step: 'record' })
  );
  render(<Fixture />);
  expect(m.replace).not.toHaveBeenCalled();
  expect(readWalkthrough(walkthroughKey('a'))).toEqual({ status: 'dismissed' });
});
it('fails closed when progress cannot be saved and ignores repeated callbacks', () => {
  render(<Fixture />);
  click('Start walkthrough');
  const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  click('created');
  click('created');
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  expect(
    m.capture.mock.calls.filter(([event]) => event === 'onboarding_step_completed')
  ).toHaveLength(0);
  blocked.mockRestore();
});

it('welcomes a new user before starting and allows deferring without a start event', () => {
  render(<Fixture />);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  expect(m.capture).not.toHaveBeenCalled();
  click('Maybe later');
  cleanup();
  render(<Fixture />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(m.capture.mock.calls.filter(([event]) => event === 'onboarding_started')).toHaveLength(0);
});

it.each([undefined, '2020-01-01T00:00:00.000Z', 'invalid'])(
  'does not welcome a returning or unknown-age account (%s)',
  signupAt => {
    m.signupAt = signupAt;
    render(<Fixture />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Tour' })).toBeNull();
  }
);

const { NewNoteDock } = await import('../components/new-note-dock');
it('preserves a queued native creation while onboarding gains its organization', () => {
  m.org = null;
  m.ready = false;
  m.create.mockClear();
  const tree = () => (
    <I18nextProvider i18n={createApplicationI18nSync()}>
      <FirstNoteWalkthroughProvider>
        <NewNoteDock />
      </FirstNoteWalkthroughProvider>
    </I18nextProvider>
  );
  const view = render(tree());
  const button = screen.getByRole('button', { name: 'New note' });
  fireEvent.click(button);
  expect(button.getAttribute('aria-busy')).toBe('true');
  m.org = 'org';
  view.rerender(tree());
  expect(screen.getByRole('button', { name: 'New note' })).toBe(button);
  expect(button.getAttribute('aria-busy')).toBe('true');
  m.ready = true;
  view.rerender(tree());
  expect(m.create).toHaveBeenCalledTimes(1);
});

it('preserves the shell but cancels its queued creation on a real workspace switch', () => {
  m.ready = false;
  m.create.mockClear();
  const tree = () => (
    <I18nextProvider i18n={createApplicationI18nSync()}>
      <FirstNoteWalkthroughProvider>
        <NewNoteDock />
      </FirstNoteWalkthroughProvider>
    </I18nextProvider>
  );
  const view = render(tree());
  const button = screen.getByRole('button', { name: 'New note' });
  fireEvent.click(button);
  m.org = 'other-org';
  view.rerender(tree());
  expect(screen.getByRole('button', { name: 'New note' })).toBe(button);
  expect(button.getAttribute('aria-busy')).toBe('false');
  m.ready = true;
  view.rerender(tree());
  expect(m.create).not.toHaveBeenCalled();
});
