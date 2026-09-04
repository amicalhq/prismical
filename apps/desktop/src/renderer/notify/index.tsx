/**
 * Notify renderer entry. No providers, no auth gate — the
 * card layer is a dumb view over window.notify (the card stream + two verbs).
 */
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { NotifyApp } from './app';
import { bootstrapPanelI18n } from '../panel-i18n';
import { mountRendererBootstrapFailure } from '../main/bootstrap-failure';
import './types';
import './notify.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('notify renderer mount point #root missing');
}

const mount = async (): Promise<void> => {
  const { initialState, instance: i18n, locale } = await bootstrapPanelI18n(window.notify.getState);
  document.documentElement.lang = locale;
  createRoot(container).render(
    <I18nextProvider i18n={i18n}>
      <NotifyApp initialState={initialState} />
    </I18nextProvider>
  );
};

void mount().catch(error => {
  console.error('Failed to initialize the notification renderer', error);
  mountRendererBootstrapFailure(container);
});
