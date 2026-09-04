// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTranslation } from 'react-i18next';
import { createApplicationI18n } from './i18n';
import {
  ApplicationI18nProvider,
  useApplicationLocale,
  type ApplicationI18nProviderProps,
} from './react';

afterEach(cleanup);

function LocaleHarness() {
  const { t } = useTranslation();
  const locale = useApplicationLocale();
  return (
    <div>
      <span data-testid="translated">{t('common.actions.save')}</span>
      <span data-testid="preference">{locale.preference}</span>
      <span data-testid="resolved">{locale.resolvedLocale}</span>
      <span data-testid="restart-required">{String(locale.restartRequired)}</span>
      <button type="button" onClick={() => void locale.changePreference('de')}>
        German
      </button>
      <button type="button" onClick={() => void locale.changePreference('ja')}>
        Japanese
      </button>
      <button type="button" onClick={() => void locale.restartApplication?.()}>
        Restart
      </button>
    </div>
  );
}

async function renderProvider(overrides: Partial<ApplicationI18nProviderProps> = {}) {
  const instance = overrides.instance ?? (await createApplicationI18n('en'));
  const persistPreference = overrides.persistPreference ?? vi.fn().mockResolvedValue(undefined);
  render(
    <ApplicationI18nProvider
      instance={instance}
      initialPreference="en"
      systemLocale="en-CA"
      applyMode="immediate"
      persistPreference={persistPreference}
      {...overrides}
    >
      <LocaleHarness />
    </ApplicationI18nProvider>
  );
  return { instance, persistPreference };
}

describe('ApplicationI18nProvider', () => {
  it('applies and persists web locale changes immediately', async () => {
    const onAppliedLocale = vi.fn();
    const { instance, persistPreference } = await renderProvider({
      onAppliedLocale,
    });

    fireEvent.click(screen.getByRole('button', { name: 'German' }));

    await waitFor(() => expect(screen.getByTestId('translated').textContent).toBe('Speichern'));
    expect(screen.getByTestId('preference').textContent).toBe('de');
    expect(screen.getByTestId('resolved').textContent).toBe('de');
    expect(instance.resolvedLanguage).toBe('de');
    expect(persistPreference).toHaveBeenCalledWith('de');
    expect(onAppliedLocale).toHaveBeenLastCalledWith('de');
  });

  it('persists a desktop selection but leaves the active locale unchanged until restart', async () => {
    const { instance, persistPreference } = await renderProvider({
      applyMode: 'restart',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }));

    await waitFor(() => expect(screen.getByTestId('preference').textContent).toBe('ja'));
    expect(screen.getByTestId('translated').textContent).toBe('Save');
    expect(screen.getByTestId('resolved').textContent).toBe('en');
    expect(screen.getByTestId('restart-required').textContent).toBe('true');
    expect(instance.resolvedLanguage).toBe('en');
    expect(persistPreference).toHaveBeenCalledWith('ja');
  });

  it('keeps an immediate language applied when browser persistence fails', async () => {
    const error = new Error('quota');
    const onPersistenceError = vi.fn();
    await renderProvider({
      persistPreference: vi.fn().mockRejectedValue(error),
      onPersistenceError,
    });

    fireEvent.click(screen.getByRole('button', { name: 'German' }));

    await waitFor(() => expect(screen.getByTestId('translated').textContent).toBe('Speichern'));
    expect(screen.getByTestId('preference').textContent).toBe('de');
    expect(onPersistenceError).toHaveBeenCalledWith(error);
  });

  it('keeps the previous desktop selection when native persistence fails', async () => {
    const error = new Error('db');
    const onPersistenceError = vi.fn();
    await renderProvider({
      applyMode: 'restart',
      persistPreference: vi.fn().mockRejectedValue(error),
      onPersistenceError,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Japanese' }));

    await waitFor(() => expect(onPersistenceError).toHaveBeenCalledWith(error));
    expect(screen.getByTestId('preference').textContent).toBe('en');
    expect(screen.getByTestId('restart-required').textContent).toBe('false');
  });

  it('exposes the platform restart action without assuming every renderer can restart', async () => {
    const restartApplication = vi.fn().mockResolvedValue(undefined);
    await renderProvider({ restartApplication });

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => expect(restartApplication).toHaveBeenCalledOnce());
  });
});
