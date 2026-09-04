// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApplicationI18nProvider, createApplicationI18n } from '@prismical/app-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterfaceLanguageSetting } from './interface-language-setting';

afterEach(cleanup);

async function renderSetting({
  applyMode = 'immediate',
  persistPreference = vi.fn().mockResolvedValue(undefined),
  restartApplication,
}: {
  applyMode?: 'immediate' | 'restart';
  persistPreference?: ReturnType<typeof vi.fn>;
  restartApplication?: () => Promise<void>;
} = {}) {
  const instance = await createApplicationI18n('en');
  render(
    <ApplicationI18nProvider
      instance={instance}
      initialPreference="en"
      systemLocale="en-CA"
      applyMode={applyMode}
      persistPreference={persistPreference}
      restartApplication={restartApplication}
    >
      <InterfaceLanguageSetting />
    </ApplicationI18nProvider>
  );
  return { instance, persistPreference };
}

describe('InterfaceLanguageSetting', () => {
  it('offers only the five complete launch locales plus the system default', async () => {
    const { instance, persistPreference } = await renderSetting();
    const select = screen.getByRole('combobox', { name: 'Interface language' });

    expect(Array.from((select as HTMLSelectElement).options, option => option.textContent)).toEqual(
      ['System default', 'English', 'Deutsch', 'Español', '日本語', '繁體中文']
    );

    fireEvent.change(select, { target: { value: 'de' } });

    await waitFor(() => expect(instance.resolvedLanguage).toBe('de'));
    expect(persistPreference).toHaveBeenCalledWith('de');
    expect(screen.getByRole('combobox', { name: 'Oberflächensprache' })).toHaveProperty(
      'value',
      'de'
    );
  });

  it('offers a restart after a desktop language selection', async () => {
    const restartApplication = vi.fn().mockResolvedValue(undefined);
    const { persistPreference } = await renderSetting({
      applyMode: 'restart',
      restartApplication,
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'ja' } });

    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Restart to change language' })).toBeTruthy();
    expect(persistPreference).toHaveBeenCalledWith('ja');

    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(restartApplication).toHaveBeenCalledOnce());
  });

  it('reverts a failed desktop selection without showing the restart dialog', async () => {
    const persistPreference = vi.fn().mockRejectedValue(new Error('write failed'));
    await renderSetting({ applyMode: 'restart', persistPreference });
    const select = screen.getByRole('combobox', { name: 'Interface language' });

    fireEvent.change(select, { target: { value: 'ja' } });

    await waitFor(() => expect(select).toHaveProperty('value', 'en'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
