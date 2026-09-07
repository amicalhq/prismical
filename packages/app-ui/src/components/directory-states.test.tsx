// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  ApplicationI18nProvider,
  createApplicationI18n,
  type SupportedLocale,
} from '@prismical/app-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryError, DirectoryLoadMore, DirectoryTruncated } from './directory-states';

afterEach(cleanup);

/** Render a component inside a resolved i18n provider for `locale`. */
async function renderLocalized(ui: React.ReactElement, locale: SupportedLocale = 'en') {
  const instance = await createApplicationI18n(locale);
  return render(
    <ApplicationI18nProvider
      instance={instance}
      initialPreference={locale}
      systemLocale={locale}
      applyMode="immediate"
      persistPreference={async () => undefined}
    >
      {ui}
    </ApplicationI18nProvider>
  );
}

describe('DirectoryError', () => {
  it('uses localized recovery copy without exposing a backend error message', async () => {
    const instance = await createApplicationI18n('de');

    render(
      <ApplicationI18nProvider
        instance={instance}
        initialPreference="de"
        systemLocale="de-DE"
        applyMode="immediate"
        persistPreference={async () => undefined}
      >
        <DirectoryError />
      </ApplicationI18nProvider>
    );

    expect(
      screen.getByText('Dieser Inhalt konnte nicht geladen werden. Versuche es erneut.')
    ).toBeTruthy();
    expect(screen.queryByText(/backend exploded/i)).toBeNull();
  });
});

describe('DirectoryLoadMore', () => {
  // Capture the observed node AND the callback, so the intersect path can actually be driven.
  let observed: Element[] = [];
  let fire: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  let disconnects = 0;
  let visibleOnObserve = false;

  const installObserver = () => {
    observed = [];
    fire = null;
    disconnects = 0;
    visibleOnObserve = false;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          fire = entries => cb(entries as IntersectionObserverEntry[], this as never);
        }
        observe(el: Element) {
          observed.push(el);
          if (visibleOnObserve) fire!([{ isIntersecting: true }]);
        }
        disconnect() {
          disconnects++;
        }
        unobserve() {}
        takeRecords() {
          return [];
        }
      }
    );
  };

  beforeEach(installObserver);
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing, and observes nothing, when there are no more pages', async () => {
    await renderLocalized(<DirectoryLoadMore hasMore={false} isLoading={false} onLoadMore={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(observed).toHaveLength(0);
  });

  it('loads more when the sentinel scrolls into view', async () => {
    const onLoadMore = vi.fn();
    await renderLocalized(<DirectoryLoadMore hasMore isLoading={false} onLoadMore={onLoadMore} />);
    expect(observed).toHaveLength(1);
    // The whole point of the sentinel: intersecting fetches the next page with no click.
    fire!([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // A non-intersecting notification must not.
    fire!([{ isIntersecting: false }]);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-fetch again while a page is already in flight', async () => {
    const onLoadMore = vi.fn();
    await renderLocalized(<DirectoryLoadMore hasMore isLoading onLoadMore={onLoadMore} />);
    expect(observed).toHaveLength(0);
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('rechecks a marker that stayed visible when loading finishes', async () => {
    visibleOnObserve = true;
    const onLoadMore = vi.fn();
    function Harness() {
      const [loading, setLoading] = useState(true);
      return (
        <>
          <button onClick={() => setLoading(false)}>Finish request</button>
          <DirectoryLoadMore hasMore isLoading={loading} onLoadMore={onLoadMore} />
        </>
      );
    }
    await renderLocalized(<Harness />);
    expect(onLoadMore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish request' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('allows a manual retry after failure without automatically requesting another page', async () => {
    visibleOnObserve = true;
    const onLoadMore = vi.fn();
    await renderLocalized(
      <DirectoryLoadMore hasMore isLoading={false} hasError onLoadMore={onLoadMore} />
    );
    expect(observed).toHaveLength(0);
    expect(onLoadMore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('loads more on click, for keyboard users and where the observer never fires', async () => {
    const onLoadMore = vi.fn();
    await renderLocalized(<DirectoryLoadMore hasMore isLoading={false} onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('keeps the button MOUNTED while loading so keyboard focus survives', async () => {
    await renderLocalized(<DirectoryLoadMore hasMore isLoading onLoadMore={() => {}} />);
    // Swapping the button out for a spinner used to drop focus to <body> mid-interaction.
    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Loading');
    // ...and the progress is announced, not just drawn.
    expect(screen.getByRole('status').textContent).toContain('Loading');
  });

  it('disconnects the observer when the sentinel unmounts', async () => {
    const { unmount } = await renderLocalized(
      <DirectoryLoadMore hasMore isLoading={false} onLoadMore={() => {}} />
    );
    unmount();
    expect(disconnects).toBeGreaterThanOrEqual(1);
  });

  it('still renders the button where IntersectionObserver does not exist', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const onLoadMore = vi.fn();
    await renderLocalized(<DirectoryLoadMore hasMore isLoading={false} onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe('DirectoryTruncated', () => {
  it('says how many rows are shown when a capped sub-list was cut off', async () => {
    await renderLocalized(<DirectoryTruncated count={200} />);
    expect(screen.getByText('Showing the most recent 200')).toBeTruthy();
  });
});
