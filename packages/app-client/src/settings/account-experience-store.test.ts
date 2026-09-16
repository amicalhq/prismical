// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_EXPERIENCE_DEFAULTS } from '@prismical/api-contracts/apps/v1';
import { AccountExperienceStore, type ExperiencePatch } from './account-experience-store';

beforeEach(() => localStorage.clear());
function server(initial: Record<string, unknown> = {}) {
  const saved: Record<string, unknown> = { language: null, transcription: null, ...initial };
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
const seed = () => structuredClone(ACCOUNT_EXPERIENCE_DEFAULTS);
const settled = async (store: AccountExperienceStore) =>
  vi.waitFor(() => expect(store.getSnapshot().pending).toBe(false));
it('ignores legacy browser choices and uses defaults without initializing the account', async () => {
  localStorage.setItem('theme', 'dark');
  localStorage.setItem('prismical:auto-enhance', '0');
  localStorage.setItem(
    'prismical:recording-preferences:v1',
    JSON.stringify({ autoTranscribeNewNotes: true, microphonePriority: [{ deviceId: 'usb' }] })
  );
  localStorage.setItem(
    'ask.model.v1',
    JSON.stringify({ instanceId: 'instance', modelId: 'model' })
  );
  localStorage.setItem('home.connect-calendar-dismissed.v1', '1');
  localStorage.setItem('apps.nudge.seen.v1', '1');
  localStorage.setItem('prismical:first-note:v1:user', JSON.stringify({ status: 'completed' }));
  const before = { ...localStorage };
  const api = server();
  const first = new AccountExperienceStore('user', api, localStorage);
  await first.refresh();
  expect(first.getSnapshot().data).toEqual(seed());
  expect(first.getSnapshot().data?.experience.autoEnhance).toBe(true);
  expect(api.patch).not.toHaveBeenCalled();
  expect(await api.get()).toEqual({ language: null, transcription: null });
  expect({ ...localStorage }).toEqual(before);
});
it('preserves backend choices across devices and saves explicit changes', async () => {
  const api = server({ ...seed(), experience: { ...seed().experience, autoEnhance: false } });
  const first = new AccountExperienceStore('user', api, localStorage);
  await first.refresh();
  expect(first.getSnapshot().data?.experience.autoEnhance).toBe(false);
  first.update({ experience: { theme: 'dark' } });
  await settled(first);
  const second = new AccountExperienceStore('user', api);
  await second.refresh();
  expect(second.getSnapshot().data).toEqual(first.getSnapshot().data);
  expect(second.getSnapshot().data?.experience).toMatchObject({
    autoEnhance: false,
    theme: 'dark',
  });
});
it('does not expose automatic behavior or accept edits until account settings are loaded', async () => {
  const api = server();
  api.get.mockRejectedValueOnce(new Error('offline'));
  const store = new AccountExperienceStore('user', api);
  await store.refresh();
  expect(store.getSnapshot()).toEqual({ data: null, error: true, pending: false });
  expect(store.update({ experience: { autoEnhance: true } })).toBe(false);
  await store.refresh();
  expect(store.getSnapshot().data?.experience.autoEnhance).toBe(true);
});
it('serializes edits and keeps later changes visible while an earlier write is pending', async () => {
  const api = server();
  const store = new AccountExperienceStore('user', api);
  await store.refresh();
  const realPatch = api.patch.getMockImplementation()!;
  let release!: () => void;
  api.patch.mockImplementationOnce(async patch => {
    await new Promise<void>(r => {
      release = r;
    });
    return realPatch(patch);
  });
  store.update({ experience: { theme: 'dark' } });
  store.update({ experience: { autoEnhance: false } });
  await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  expect(store.getSnapshot().data?.experience).toMatchObject({ theme: 'dark', autoEnhance: false });
  release();
  await settled(store);
  expect(api.patch).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().data?.experience).toMatchObject({ theme: 'dark', autoEnhance: false });
});
it('retries failed dismissals after reload and never shares the outbox with another user', async () => {
  const api = server();
  const store = new AccountExperienceStore('user', api, localStorage);
  await store.refresh();
  api.patch.mockRejectedValueOnce(new Error('offline'));
  store.update({ prompts: { calendarDismissed: true } });
  await vi.waitFor(() => expect(store.getSnapshot().error).toBe(true));
  expect(store.getSnapshot().data?.prompts.calendarDismissed).toBe(true);
  store.dispose();
  const other = new AccountExperienceStore('other', server(), localStorage);
  await other.refresh();
  expect(other.getSnapshot().data?.prompts.calendarDismissed).toBe(false);
  const restored = new AccountExperienceStore('user', api, localStorage);
  await restored.refresh();
  expect(restored.getSnapshot()).toMatchObject({
    error: false,
    pending: false,
    data: { prompts: { calendarDismissed: true } },
  });
  expect(localStorage.length).toBe(0);
});
it('does not let another tab erase a failed pending operation', async () => {
  const api = server();
  const first = new AccountExperienceStore('user', api, localStorage);
  const second = new AccountExperienceStore('user', api, localStorage);
  await first.refresh();
  await second.refresh();
  api.patch.mockRejectedValueOnce(new Error('offline'));
  first.update({ prompts: { calendarDismissed: true } });
  await vi.waitFor(() => expect(first.getSnapshot().error).toBe(true));
  second.update({ experience: { theme: 'dark' } });
  await settled(second);
  expect(localStorage.length).toBe(1);
  await first.refresh();
  expect(localStorage.length).toBe(0);
});
it('ignores late responses and queued writes after an account is disposed', async () => {
  const api = server();
  const store = new AccountExperienceStore('user', api);
  await store.refresh();
  let release!: () => void;
  api.patch.mockImplementationOnce(async () => {
    await new Promise<void>(r => {
      release = r;
    });
    return { ...seed(), language: null, transcription: null };
  });
  store.update({ experience: { theme: 'dark' } });
  store.update({ experience: { autoEnhance: false } });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  store.dispose();
  release();
  await new Promise(r => setTimeout(r, 0));
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(store.update({ experience: { theme: 'light' } })).toBe(false);
});
it('refreshes changed server values and isolates Ask choices by organization', async () => {
  const api = server();
  const store = new AccountExperienceStore('user', api);
  await store.refresh();
  await api.patch({
    experience: { theme: 'dark' },
    ask: {
      orgA: { instanceId: 'a', modelId: 'a-model' },
      orgB: { instanceId: 'b', modelId: 'b-model' },
    },
  });
  await store.refresh();
  expect(store.getSnapshot().data?.experience.theme).toBe('dark');
  expect(store.getSnapshot().data?.ask).toEqual({
    orgA: { instanceId: 'a', modelId: 'a-model' },
    orgB: { instanceId: 'b', modelId: 'b-model' },
  });
});

it('does not re-open a completed tour while retrying stale progress', async () => {
  const api = server({
    onboarding: { walkthrough: { status: 'completed' }, replayRetired: true },
    prompts: { getAppsSeen: false, calendarDismissed: true },
  });
  const store = new AccountExperienceStore('user', api);
  await store.refresh();
  api.patch.mockRejectedValue(new Error('offline'));
  store.update({
    onboarding: {
      walkthrough: { status: 'active', orgId: 'org', noteId: 'note', step: 'record' },
      replayRetired: false,
    },
    prompts: { calendarDismissed: false },
  });
  expect(store.getSnapshot().data?.onboarding).toEqual({
    walkthrough: { status: 'completed' },
    replayRetired: true,
  });
  expect(store.getSnapshot().data?.prompts.calendarDismissed).toBe(true);
});

it('discards acknowledged operations from another tab before retrying stale work', async () => {
  const api = server();
  const first = new AccountExperienceStore('user', api, localStorage);
  await first.refresh();
  api.patch.mockRejectedValueOnce(new Error('offline'));
  first.update({ experience: { theme: 'dark' } });
  await vi.waitFor(() => expect(first.getSnapshot().error).toBe(true));
  const staleTab = new AccountExperienceStore('user', api, localStorage);
  await first.refresh();
  first.update({ experience: { theme: 'light' } });
  await settled(first);
  expect((await api.get()).experience).toMatchObject({ theme: 'light' });
  expect(localStorage.length).toBe(0);
  await staleTab.refresh();
  expect((await api.get()).experience).toMatchObject({ theme: 'light' });
  expect(staleTab.getSnapshot().data?.experience.theme).toBe('light');
});

it('serializes simultaneous tab drains and sends a shared pending operation only once', async () => {
  const api = server();
  const first = new AccountExperienceStore('user', api, localStorage);
  await first.refresh();
  const realPatch = api.patch.getMockImplementation()!;
  let release!: () => void;
  api.patch.mockImplementationOnce(async patch => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return realPatch(patch);
  });
  first.update({ experience: { theme: 'dark' } });
  await vi.waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  const second = new AccountExperienceStore('user', api, localStorage);
  const secondDrain = second.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(api.patch).toHaveBeenCalledTimes(1);
  release();
  await secondDrain;
  await settled(first);
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(second.getSnapshot().data?.experience.theme).toBe('dark');
});

it('acknowledges an in-flight save even after the account switches', async () => {
  const api = server();
  const first = new AccountExperienceStore('user', api, localStorage);
  await first.refresh();
  const realPatch = api.patch.getMockImplementation()!;
  let release!: () => void;
  api.patch.mockImplementationOnce(async patch => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return realPatch(patch);
  });
  first.update({ experience: { theme: 'dark' } });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  first.dispose();
  release();
  await vi.waitFor(() => expect(localStorage.length).toBe(0));
  await api.patch({ experience: { theme: 'light' } });
  const restored = new AccountExperienceStore('user', api, localStorage);
  await restored.refresh();
  expect(restored.getSnapshot().data?.experience.theme).toBe('light');
});

it('allows an explicit tour replay for an account with retired onboarding', async () => {
  const api = server({ onboarding: { walkthrough: { status: 'completed' }, replayRetired: true } });
  const store = new AccountExperienceStore('user', api);
  await store.refresh();
  const walkthrough = { status: 'offered', replay: true, started: true } as const;
  expect(store.update({ onboarding: { walkthrough } })).toBe(true);
  expect(store.getSnapshot().data?.onboarding.walkthrough).toEqual(walkthrough);
  await settled(store);
  expect(store.getSnapshot().data?.onboarding.walkthrough).toEqual(walkthrough);
  store.dispose();
});
