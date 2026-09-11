// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ApplicationI18nProvider,
  createApplicationI18n,
  useApplicationLocale,
  type ApplicationI18nProviderProps,
} from '@prismical/app-i18n';
import { AccountLanguageProvider, useAccountLanguage } from './account-language-provider';
import { ApiError, apiClient } from '../api/client';

vi.mock('../api/client', async importOriginal => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  ME_PREFIX: '/apps/v1/me',
  apiClient: { getRaw: vi.fn(), postRaw: vi.fn(), patchRaw: vi.fn() },
}));
const session = vi.hoisted(() => ({ key: 'account-a' }));
vi.mock('../ports-context', () => ({
  useActiveSessionKey: () => session.key,
  useSessionView: () => ({ state: 'signed-in' }),
}));
function Settings() {
  const locale = useApplicationLocale();
  const account = useAccountLanguage();
  return (
    <>
      <span data-testid="language">{locale.preference}</span>
      <span data-testid="resolved">{locale.resolvedLocale}</span>
      <span data-testid="restart-required">{String(locale.restartRequired)}</span>
      <span data-testid="saving">{String(locale.isSaving)}</span>
      <span data-testid="output">{account?.preferences?.aiOutputLanguage}</span>
      <span data-testid="error">{String(account?.error)}</span>
      <button onClick={() => void locale.changePreference('ja')}>Japanese</button>
    </>
  );
}
async function mount(
  isReady = true,
  options: Pick<
    Partial<ApplicationI18nProviderProps>,
    'applyMode' | 'persistPreference' | 'onPersistenceError' | 'initialPreference'
  > = {}
) {
  const instance = await createApplicationI18n('en');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const persist = options.persistPreference ?? vi.fn();
  const view = () => (
    <QueryClientProvider client={client}>
      <ApplicationI18nProvider
        instance={instance}
        initialPreference="system"
        systemLocale="de-DE"
        applyMode="immediate"
        isReady={isReady}
        persistPreference={persist}
        {...options}
      >
        <AccountLanguageProvider>
          <Settings />
        </AccountLanguageProvider>
      </ApplicationI18nProvider>
    </QueryClientProvider>
  );
  const rendered = render(view());
  return {
    instance,
    client,
    persist,
    switchSession: (key: string) => {
      session.key = key;
      rendered.rerender(view());
    },
  };
}
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  session.key = 'account-a';
});
describe('account language preference', () => {
  const saved = (interfaceLanguage: string, aiOutputLanguage = 'source') => ({
    language: { interfaceLanguage, aiOutputLanguage },
  });
  it('applies an existing account choice without writing anything', async () => {
    vi.mocked(apiClient.getRaw).mockResolvedValue(saved('es', 'hi'));
    const { instance } = await mount();
    await waitFor(() => expect(instance.resolvedLanguage).toBe('es'));
    expect(apiClient.getRaw).toHaveBeenCalledWith('/apps/v1/me/preferences', undefined, {
      activeOrgId: null,
    });
    expect(screen.getByTestId('output').textContent).toBe('hi');
    expect(apiClient.postRaw).not.toHaveBeenCalled();
    expect(apiClient.patchRaw).not.toHaveBeenCalled();
  });
  it('initializes an account that never chose a language from the detected locale, once', async () => {
    vi.mocked(apiClient.getRaw).mockResolvedValue({ language: null });
    vi.mocked(apiClient.postRaw).mockResolvedValue(saved('de'));
    const { instance } = await mount();
    await waitFor(() => expect(instance.resolvedLanguage).toBe('de'));
    expect(apiClient.postRaw).toHaveBeenCalledTimes(1);
    expect(apiClient.postRaw).toHaveBeenCalledWith(
      '/apps/v1/me/preferences',
      { language: { interfaceLanguage: 'de' } },
      { activeOrgId: null }
    );
    expect(screen.getByTestId('output').textContent).toBe('source');
  });
  it('retries a desktop workspace that is still mounting', async () => {
    vi.mocked(apiClient.getRaw)
      .mockRejectedValueOnce(new ApiError('INTERNAL', 'Workspace starting', 0))
      .mockResolvedValueOnce(saved('de'));
    const { instance } = await mount();
    await waitFor(() => expect(instance.resolvedLanguage).toBe('de'));
    expect(apiClient.getRaw).toHaveBeenCalledTimes(2);
    expect(apiClient.postRaw).not.toHaveBeenCalled();
  });
  it('waits for verified desktop persistence before selecting an account choice and requiring restart', async () => {
    vi.mocked(apiClient.getRaw).mockResolvedValue(saved('ja'));
    let finishPersist!: () => void;
    const persist = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishPersist = resolve;
        })
    );
    const { instance } = await mount(true, { applyMode: 'restart', persistPreference: persist });

    await waitFor(() => expect(persist).toHaveBeenCalledWith('ja'));
    expect(screen.getByTestId('language').textContent).toBe('de');
    expect(screen.getByTestId('saving').textContent).toBe('true');
    expect(screen.getByTestId('restart-required').textContent).toBe('false');
    await act(async () => finishPersist());
    await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('ja'));
    expect(screen.getByTestId('restart-required').textContent).toBe('true');
    expect(screen.getByTestId('resolved').textContent).toBe('en');
    expect(instance.resolvedLanguage).toBe('en');
    expect(apiClient.patchRaw).not.toHaveBeenCalled();
  });
  it('keeps a failed desktop write unselected and retries the same saved choice without another PATCH', async () => {
    vi.mocked(apiClient.getRaw).mockResolvedValue(saved('en'));
    vi.mocked(apiClient.patchRaw).mockResolvedValue(saved('ja'));
    const error = new Error('Device write was not verified');
    const persist = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const onPersistenceError = vi.fn();
    const { instance } = await mount(true, {
      applyMode: 'restart',
      persistPreference: persist,
      onPersistenceError,
    });
    await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('en'));
    await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('false'));

    fireEvent.click(screen.getByText('Japanese'));
    await waitFor(() => expect(onPersistenceError).toHaveBeenCalledWith(error));
    expect(screen.getByTestId('language').textContent).toBe('en');
    expect(screen.getByTestId('restart-required').textContent).toBe('false');
    expect(apiClient.patchRaw).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText('Japanese'));
    await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('ja'));
    expect(screen.getByTestId('restart-required').textContent).toBe('true');
    expect(persist.mock.calls.map(([language]) => language)).toEqual(['en', 'ja', 'ja']);
    expect(apiClient.patchRaw).toHaveBeenCalledOnce();
    expect(instance.resolvedLanguage).toBe('en');
  });
  it('keeps a failed first desktop apply on a supported device choice', async () => {
    vi.mocked(apiClient.getRaw).mockResolvedValue(saved('ja'));
    const error = new Error('Device write failed');
    const persist = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const onPersistenceError = vi.fn();
    await mount(true, { applyMode: 'restart', persistPreference: persist, onPersistenceError });

    await waitFor(() => expect(onPersistenceError).toHaveBeenCalledWith(error));
    expect(screen.getByTestId('language').textContent).toBe('de');
    expect(screen.getByTestId('restart-required').textContent).toBe('false');
    fireEvent.click(screen.getByText('Japanese'));
    await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('ja'));
    expect(screen.getByTestId('restart-required').textContent).toBe('true');
    expect(apiClient.patchRaw).not.toHaveBeenCalled();
  });
  it('does not seed an old account after its pending read completes on a new account', async () => {
    let finishRead!: (value: unknown) => void;
    vi.mocked(apiClient.getRaw)
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishRead = resolve;
          })
      )
      .mockResolvedValueOnce(saved('es'));
    const { switchSession } = await mount();
    await waitFor(() => expect(apiClient.getRaw).toHaveBeenCalledOnce());
    switchSession('account-b');
    await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('es'));

    await act(async () => finishRead({ language: null }));
    expect(apiClient.postRaw).not.toHaveBeenCalled();
    expect(screen.getByTestId('language').textContent).toBe('es');
  });
  it.each(['system', 'en'] as const)(
    'ignores an old account native write with device preference %s',
    async initialPreference => {
      vi.mocked(apiClient.getRaw)
        .mockResolvedValueOnce(saved('ja'))
        .mockResolvedValueOnce(saved('en'));
      let finishOldPersist!: () => void;
      let finishCurrentPersist!: () => void;
      let persisted = initialPreference as string;
      const onPersistenceError = vi.fn();
      // Native writes happen in call order; read-back verification can complete later.
      const persist = vi.fn((language: string) => {
        persisted = language;
        return new Promise<void>((resolve, reject) => {
          const verify = () =>
            persisted === language
              ? resolve()
              : reject(new Error('Desktop locale preference was not persisted'));
          if (language === 'ja') finishOldPersist = verify;
          else finishCurrentPersist = verify;
        });
      });
      const { switchSession } = await mount(true, {
        applyMode: 'restart',
        initialPreference,
        persistPreference: persist,
        onPersistenceError,
      });
      await waitFor(() => expect(persist).toHaveBeenCalledWith('ja'));
      switchSession('account-b');
      await waitFor(() => expect(persist).toHaveBeenCalledWith('en'));

      await act(async () => finishOldPersist());
      expect(screen.getByTestId('language').textContent).toBe(
        initialPreference === 'system' ? 'de' : 'en'
      );
      expect(screen.getByTestId('restart-required').textContent).toBe('false');
      expect(screen.getByTestId('saving').textContent).toBe('true');
      await act(async () => finishCurrentPersist());
      await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('en'));
      expect(screen.getByTestId('restart-required').textContent).toBe('false');
      expect(persist.mock.calls.map(([language]) => language)).toEqual(['ja', 'en']);
      expect(persisted).toBe('en');
      expect(onPersistenceError).not.toHaveBeenCalled();
      expect(apiClient.patchRaw).not.toHaveBeenCalled();
    }
  );
  it('does not save the temporary English hydration locale', async () => {
    await mount(false);
    expect(apiClient.getRaw).not.toHaveBeenCalled();
    expect(apiClient.postRaw).not.toHaveBeenCalled();
  });
  it('keeps the saved language on failure, then saves before applying a successful edit', async () => {
    vi.mocked(apiClient.getRaw).mockResolvedValue(saved('de', 'source'));
    vi.mocked(apiClient.patchRaw)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(saved('ja', 'source'));
    const { instance } = await mount();
    await waitFor(() => expect(instance.resolvedLanguage).toBe('de'));
    fireEvent.click(screen.getByText('Japanese'));
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('true'));
    expect(instance.resolvedLanguage).toBe('de');
    fireEvent.click(screen.getByText('Japanese'));
    await waitFor(() => expect(instance.resolvedLanguage).toBe('ja'));
    expect(apiClient.patchRaw).toHaveBeenLastCalledWith(
      '/apps/v1/me/preferences',
      { language: { interfaceLanguage: 'ja' } },
      { activeOrgId: null }
    );
  });
  it('keeps the interface picker usable device-locally when the account cannot be read', async () => {
    vi.mocked(apiClient.getRaw).mockRejectedValue(new Error('gateway down'));
    const { instance, persist } = await mount();
    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('true'));
    fireEvent.click(screen.getByText('Japanese'));
    await waitFor(() => expect(instance.resolvedLanguage).toBe('ja'));
    expect(persist).toHaveBeenCalled();
    expect(apiClient.patchRaw).not.toHaveBeenCalled();
    expect(apiClient.postRaw).not.toHaveBeenCalled();
  });
  it('applies a refreshed account preference without writing it back', async () => {
    vi.mocked(apiClient.getRaw).mockResolvedValue(saved('de', 'source'));
    const { instance, client } = await mount();
    await waitFor(() => expect(instance.resolvedLanguage).toBe('de'));
    await act(async () => {
      client.setQueryData(['account-language', 'account-a'], {
        interfaceLanguage: 'es',
        aiOutputLanguage: 'fr',
      });
    });
    await waitFor(() => expect(instance.resolvedLanguage).toBe('es'));
    expect(apiClient.patchRaw).not.toHaveBeenCalled();
  });
  it.each(['immediate', 'restart'] as const)(
    'keeps an in-flight save on its original account in %s mode',
    async applyMode => {
      vi.mocked(apiClient.getRaw)
        .mockResolvedValueOnce(saved('de', 'source'))
        .mockResolvedValueOnce(saved('es', 'fr'));
      let finishSave!: (value: unknown) => void;
      vi.mocked(apiClient.patchRaw).mockImplementation(
        () =>
          new Promise(resolve => {
            finishSave = resolve;
          })
      );
      const { instance, client, persist, switchSession } = await mount(true, { applyMode });
      await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('de'));
      await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('false'));
      fireEvent.click(screen.getByText('Japanese'));
      await waitFor(() => expect(apiClient.patchRaw).toHaveBeenCalledOnce());
      switchSession('account-b');
      await waitFor(() => expect(screen.getByTestId('language').textContent).toBe('es'));
      await act(async () => finishSave(saved('ja', 'source')));
      expect(screen.getByTestId('language').textContent).toBe('es');
      expect(instance.resolvedLanguage).toBe(applyMode === 'restart' ? 'en' : 'es');
      expect(persist).not.toHaveBeenCalledWith('ja');
      expect(client.getQueryData(['account-language', 'account-b'])).toEqual({
        interfaceLanguage: 'es',
        aiOutputLanguage: 'fr',
      });
      expect(client.getQueryData(['account-language', 'account-a'])).toEqual({
        interfaceLanguage: 'ja',
        aiOutputLanguage: 'source',
      });
    }
  );
});
