import { catalogs, defaultLocale } from '@prismical/app-i18n';
import { initializeDesktopI18n, type DesktopI18nFactory } from '../../shared/application-i18n';

/** A last-resort renderer surface when the locale/env IPC bootstrap cannot complete. */
export const mountRendererBootstrapFailure = (
  root: HTMLElement,
  systemLocale = window.navigator.language,
  reload: () => void = () => window.location.reload(),
  createI18n?: DesktopI18nFactory
): void => {
  let locale = defaultLocale;
  let titleText = catalogs.en.desktop.fatal.title;
  let descriptionText = catalogs.en.desktop.fatal.rendererDescription;
  let reloadText = catalogs.en.desktop.fatal.reload;
  try {
    const initialized = initializeDesktopI18n(systemLocale, createI18n);
    locale = initialized.locale;
    titleText = initialized.instance.t('desktop.fatal.title');
    descriptionText = initialized.instance.t('desktop.fatal.rendererDescription');
    reloadText = initialized.instance.t('desktop.fatal.reload');
  } catch {
    // If i18next itself is unavailable, the source catalog still provides a
    // terminal English recovery surface instead of leaving the window blank.
  }
  document.documentElement.lang = locale;

  const surface = document.createElement('main');
  surface.setAttribute('role', 'alert');
  surface.className =
    'bg-background text-foreground flex min-h-screen items-center justify-center px-6 py-10';

  const card = document.createElement('div');
  card.className = 'bg-card w-full max-w-sm rounded-lg border p-6 text-center shadow-lg';

  const title = document.createElement('h1');
  title.className = 'text-base font-semibold';
  title.textContent = titleText;

  const description = document.createElement('p');
  description.className = 'text-muted-foreground mt-2 text-sm';
  description.textContent = descriptionText;

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className =
    'bg-primary text-primary-foreground mt-4 rounded-md px-3 py-2 text-sm font-medium';
  retry.textContent = reloadText;
  retry.addEventListener('click', reload);

  card.append(title, description, retry);
  surface.append(card);
  root.replaceChildren(surface);
};
