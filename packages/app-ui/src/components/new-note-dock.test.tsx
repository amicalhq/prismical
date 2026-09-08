// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { I18nextProvider } from 'react-i18next';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  error: vi.fn(),
  push: vi.fn(),
  storeReady: false,
  orgId: 'org_1' as string | null,
  sessionKey: 'session_1' as string | null,
}));

// Known infidelity: `orgId` and `storeReady` are independent here, but in the real app changing
// the org TEARS DOWN the sync store (SyncStoreProvider's deps include orgId), so the two never
// flip on one commit. Tests that set both together are asserting a state production cannot reach;
// the sequenced tests below are the ones that model reality.
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));

vi.mock('@prismical/app-client', () => ({
  // Mirrors the real hook: a FRESH object every render, and `isPending` while the store is null.
  useCreateNote: () => ({
    mutate: mocks.mutate,
    mutateAsync: vi.fn(),
    isPending: !mocks.storeReady,
  }),
  useNavigation: () => ({ push: mocks.push }),
  useActiveOrgId: () => mocks.orgId,
  useActiveSessionKey: () => mocks.sessionKey,
}));

const { NewNoteDock } = await import('./new-note-dock');

function renderDock() {
  const i18n = createApplicationI18nSync();
  return render(
    <I18nextProvider i18n={i18n}>
      <NewNoteDock />
    </I18nextProvider>
  );
}

describe('NewNoteDock cold-start latch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.mutate.mockReset();
    mocks.error.mockReset();
    mocks.push.mockReset();
    mocks.storeReady = false;
    mocks.orgId = 'org_1';
    mocks.sessionKey = 'session_1';
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('honours a click that lands before the sync store is ready', () => {
    const { rerender } = renderDock();
    fireEvent.click(screen.getByLabelText('New note'));
    expect(mocks.mutate).not.toHaveBeenCalled(); // store still null

    mocks.storeReady = true;
    act(() => {
      rerender(
        <I18nextProvider i18n={createApplicationI18nSync()}>
          <NewNoteDock />
        </I18nextProvider>
      );
    });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('expires the latch on schedule even while the component keeps re-rendering', () => {
    // The regression this guards: `useCreateNote` returns a new object every render and the dock
    // re-renders on every navigation. With the expiry armed alongside those values, each render
    // cleared and re-armed the timer, so the deadline never arrived and a long-delayed store
    // publish could yank the user out of whatever screen they had moved on to.
    const { rerender } = renderDock();
    fireEvent.click(screen.getByLabelText('New note'));

    for (let elapsed = 0; elapsed < 8000; elapsed += 1000) {
      act(() => {
        vi.advanceTimersByTime(1000);
        rerender(
          <I18nextProvider i18n={createApplicationI18nSync()}>
            <NewNoteDock />
          </I18nextProvider>
        );
      });
    }

    mocks.storeReady = true;
    act(() => {
      rerender(
        <I18nextProvider i18n={createApplicationI18nSync()}>
          <NewNoteDock />
        </I18nextProvider>
      );
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('Couldn’t create the note. Please try again.');
  });

  it('still fires when the org merely RESOLVES from null during the wait', () => {
    // The cold-load case the latch exists for: on first paint the active org is not known yet, so
    // the click is queued with `null`. Treating the later null -> 'org_1' resolution as an org
    // SWITCH threw the click away precisely when it mattered.
    mocks.orgId = null;
    const { rerender } = renderDock();
    fireEvent.click(screen.getByLabelText('New note'));
    mocks.orgId = 'org_1';
    mocks.storeReady = true;
    act(() => {
      rerender(
        <I18nextProvider i18n={createApplicationI18nSync()}>
          <NewNoteDock />
        </I18nextProvider>
      );
    });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it('guards a null-org latch once the org resolves, and drops it on a later switch', () => {
    // The gap the previous fix left: treating null as "unknown" made the latch tolerant of the
    // resolution, but it also left it unguarded for its whole life. Sequenced the way production
    // actually behaves — org resolves first (store still rebuilding), switch happens after.
    mocks.orgId = null;
    const { rerender } = renderDock();
    fireEvent.click(screen.getByLabelText('New note'));
    const paint = () =>
      act(() => {
        rerender(
          <I18nextProvider i18n={createApplicationI18nSync()}>
            <NewNoteDock />
          </I18nextProvider>
        );
      });

    mocks.orgId = 'org_1'; // resolves; store still down, so nothing fires yet
    paint();
    expect(mocks.mutate).not.toHaveBeenCalled();

    mocks.orgId = 'org_2'; // user switches workspace while still waiting
    paint();
    mocks.storeReady = true; // the new org's store publishes
    paint();
    expect(mocks.mutate).not.toHaveBeenCalled(); // must NOT create in org_2
  });

  it('drops a queued click when the login session changes within the same workspace', () => {
    const { rerender } = renderDock();
    fireEvent.click(screen.getByLabelText('New note'));
    mocks.sessionKey = 'session_2';
    mocks.storeReady = true;
    act(() => {
      rerender(
        <I18nextProvider i18n={createApplicationI18nSync()}>
          <NewNoteDock />
        </I18nextProvider>
      );
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('drops the latch when the org switches underneath it', () => {
    const { rerender } = renderDock();
    fireEvent.click(screen.getByLabelText('New note'));
    mocks.orgId = 'org_2';
    mocks.storeReady = true;
    act(() => {
      rerender(
        <I18nextProvider i18n={createApplicationI18nSync()}>
          <NewNoteDock />
        </I18nextProvider>
      );
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('shows feedback for a synchronous creation failure and allows a new click', () => {
    mocks.storeReady = true;
    mocks.mutate.mockImplementationOnce(() => {
      throw new Error('store unavailable');
    });
    renderDock();
    fireEvent.click(screen.getByLabelText('New note'));
    expect(mocks.error).toHaveBeenCalledWith('Couldn’t create the note. Please try again.');
    fireEvent.click(screen.getByLabelText('New note'));
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
  });
});
