/**
 * Widget renderer entry. No providers, no auth gate — the
 * widget is a dumb view over window.widget (the state stream + five verbs).
 */
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { WidgetApp } from './app';
import { bootstrapPanelI18n } from '../panel-i18n';
import { mountRendererBootstrapFailure } from '../main/bootstrap-failure';
import './types';
import './widget.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('widget renderer mount point #root missing');
}

const mount = async (): Promise<void> => {
  const { initialState, instance: i18n, locale } = await bootstrapPanelI18n(window.widget.getState);
  document.documentElement.lang = locale;
  createRoot(container).render(
    <I18nextProvider i18n={i18n}>
      <WidgetApp initialState={initialState} />
    </I18nextProvider>
  );
};

void mount().catch(error => {
  console.error('Failed to initialize the recording widget renderer', error);
  mountRendererBootstrapFailure(container);
});
