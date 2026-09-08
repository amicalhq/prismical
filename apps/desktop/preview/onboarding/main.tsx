import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import type { AppModeValue, OnboardingState } from '@prismical/desktop-contracts';
import { Button } from '@prismical/app-ui/ui/button';
import { OnboardingFlow } from '../../src/renderer/main/app/onboarding/flow';
import { CalendarOnboarding } from '../../src/renderer/main/app/onboarding/calendar';
import { GateCard } from '../../src/renderer/main/gate-card';
import { resetServices } from './services';
import '../../src/renderer/main/app/globals.css';

let selectedMode: AppModeValue = 'cloud';
Object.assign(window, {
  desktop: {
    capabilities: {
      chooseAppMode: async ({ mode }: { mode: AppModeValue }) => {
        selectedMode = mode;
        return { relaunch: false };
      },
    },
    nav: { onPush: () => () => {} },
  },
});

function Preview() {
  const [progress, setProgress] = useState<OnboardingState | null>(null);
  const [surface, setSurface] = useState<'flow' | 'signin' | 'calendar' | 'complete'>('flow');
  const [revision, setRevision] = useState(0);
  const [dark, setDark] = useState(true);
  const show = (step: 'discovery' | 'permissions' | 'mode') => {
    resetServices();
    setProgress({ step, discoverySource: null, discoveryDetails: '' });
    setSurface('flow');
    setRevision(value => value + 1);
  };
  return (
    <>
      <aside className="bg-background/95 text-muted-foreground fixed top-2 right-2 z-40 flex flex-wrap items-center gap-1 rounded-lg border p-1.5 text-xs shadow-sm">
        <span className="px-2">Preview · simulated services</span>
        <select
          aria-label="Preview screen"
          className="bg-background text-foreground rounded border px-2 py-1"
          value={surface === 'flow' ? (progress?.step ?? 'discovery') : surface}
          onChange={event => show(event.target.value as 'discovery' | 'permissions' | 'mode')}
        >
          {surface === 'complete' && <option value="complete">Complete</option>}
          {surface === 'signin' && <option value="signin">Sign in</option>}
          <option value="discovery">Discovery</option>
          <option value="permissions">Permissions</option>
          <option value="mode">Mode</option>
          {surface === 'calendar' && <option value="calendar">Calendar</option>}
        </select>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            document.documentElement.classList.toggle('dark', !dark);
            setDark(!dark);
          }}
        >
          {dark ? 'Light' : 'Dark'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => show('discovery')}>
          Restart
        </Button>
      </aside>
      {surface === 'flow' && (
        <OnboardingFlow
          key={revision}
          progress={progress}
          save={async next => setProgress(next)}
          onChosen={() => setSurface(selectedMode === 'cloud' ? 'signin' : 'complete')}
        />
      )}
      {surface === 'signin' && (
        <div className="bg-background text-foreground fixed inset-0 flex items-center justify-center p-6">
          <GateCard>
            <p className="text-muted-foreground mb-5 text-center text-sm">
              The app waits for sign-in to finish in your browser. This preview simulates that step.
            </p>
            <Button className="w-full" onClick={() => setSurface('calendar')}>
              Simulate successful sign-in
            </Button>
          </GateCard>
        </div>
      )}
      {surface === 'calendar' && (
        <CalendarOnboarding key={revision} onComplete={async () => setSurface('complete')} />
      )}
      {surface === 'complete' && (
        <div className="bg-background text-foreground fixed inset-0 grid place-content-center gap-4 text-center">
          <h1 className="text-3xl font-semibold">Setup complete</h1>
          <p className="text-muted-foreground">
            The desktop app opens here. This preview ends at onboarding.
          </p>
          <Button onClick={() => show('discovery')}>Preview again</Button>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={createApplicationI18nSync('en')}>
    <Preview />
  </I18nextProvider>
);
