// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { ACCOUNT_EXPERIENCE_DEFAULTS } from '@prismical/api-contracts/apps/v1';
import { AccountExperienceStore, type ExperiencePatch } from './account-experience-store';

/**
 * The one-time prompts write their acknowledgment in reaction to the very load that revealed them,
 * which is a case no store-only test reaches. `publish()` runs INSIDE the refresh pass and only
 * schedules a React render; the effect that writes therefore lands a microtask later - after the
 * pass has already checked its queue and found it empty, but before it clears `running`. The
 * write's own `refresh()` call can only return early at that point, so nothing would deliver it.
 *
 * A synchronous subscriber cannot reproduce this: it runs during `publish()`, so the write is
 * already queued when the drain loop looks. Only a real render puts it in the window.
 */
function seed() {
  return structuredClone(ACCOUNT_EXPERIENCE_DEFAULTS);
}

function transport() {
  const saved: Record<string, unknown> = { language: null, transcription: null };
  return {
    get: vi.fn(async () => structuredClone(saved)),
    patch: vi.fn(async (patch: ExperiencePatch) => {
      for (const [key, value] of Object.entries(patch))
        saved[key] = {
          ...seed()[key as keyof ExperiencePatch],
          ...(saved[key] as object),
          ...value,
        };
      return structuredClone(saved);
    }),
  };
}

/** Stands in for a one-time prompt: reads the store, and on first data writes its acknowledgment. */
function Prompt({ store }: { store: AccountExperienceStore }) {
  const snapshot = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  const written = React.useRef(false);
  React.useEffect(() => {
    if (written.current || !snapshot.data || snapshot.data.welcome.seen) return;
    written.current = true;
    store.update({ welcome: { seen: true } });
  }, [snapshot.data, store]);
  return null;
}

it('delivers a prompt acknowledgment written in reaction to the opening load', async () => {
  const api = transport();
  const store = new AccountExperienceStore('user', api);
  render(<Prompt store={store} />);

  void store.refresh();

  // Nothing here triggers a second refresh: no timer, no focus event, no further update. If the
  // pass does not re-drive itself, this write never reaches the server and another device reads
  // the stale value.
  await waitFor(() => expect(api.patch).toHaveBeenCalledWith({ welcome: { seen: true } }));
  await waitFor(() => expect(store.getSnapshot().pending).toBe(false));
  expect(store.getSnapshot().data?.welcome.seen).toBe(true);
});
