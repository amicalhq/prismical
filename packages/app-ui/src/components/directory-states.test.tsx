// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { ApplicationI18nProvider, createApplicationI18n } from '@prismical/app-i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectoryError } from './directory-states';

afterEach(cleanup);

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
