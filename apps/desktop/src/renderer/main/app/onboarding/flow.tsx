import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppModeValue, OnboardingState } from '@prismical/desktop-contracts';
import { Button } from '@prismical/app-ui/ui/button';
import { Input } from '@prismical/app-ui/ui/input';
import { PermissionsSetting } from '@prismical/app-ui/screens/settings/permissions-setting';
import { ModeChooser } from '../mode-chooser';
import { OnboardingFrame } from './frame';

const DISCOVERY_SOURCES = [
  'searchEngine',
  'reddit',
  'xTwitter',
  'socialMedia',
  'aiAssistant',
  'wordOfMouth',
  'blogArticle',
  'github',
  'other',
] as const;

export function OnboardingFlow({
  progress,
  save,
  onChosen,
}: {
  progress: OnboardingState | null;
  save: (progress: OnboardingState) => Promise<void>;
  onChosen: () => void;
}) {
  const { t } = useTranslation();
  const step =
    progress?.step === 'permissions'
      ? 'permissions'
      : progress && progress.step !== 'discovery'
        ? 'mode'
        : 'discovery';
  const [source, setSource] = useState(progress?.discoverySource ?? null);
  const [details, setDetails] = useState(progress?.discoveryDetails ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'restarting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const busy = state !== 'idle';
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setState('saving');
    setError(null);
    try {
      await action();
    } catch {
      setError(t('desktop.modeChooser.failed'));
    } finally {
      locked.current = false;
      setState(current => (current === 'restarting' ? current : 'idle'));
    }
  };
  const advance = (next: OnboardingState['step'], skip = false) =>
    save({
      step: next,
      discoverySource: skip ? null : source,
      discoveryDetails: !skip && source === 'other' ? details.trim() : '',
    });
  const choose = (mode: AppModeValue) =>
    void run(async () => {
      // Save the remaining step before chooseAppMode can relaunch the process.
      await advance(mode === 'cloud' ? 'calendar' : 'complete');
      const result = await window.desktop.capabilities.chooseAppMode({ mode });
      if (result.relaunch) setState('restarting');
      else onChosen();
    });

  return (
    <OnboardingFrame
      step={step}
      error={error}
      footer={
        <>
          {step === 'discovery' ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await advance('permissions', true);
                  setSource(null);
                  setDetails('');
                })
              }
            >
              {t('desktop.onboarding.skip')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => advance(step === 'mode' ? 'permissions' : 'discovery'))}
            >
              {t('common.actions.back')}
            </Button>
          )}
          {step !== 'mode' && (
            <Button
              data-testid="onboarding-continue"
              disabled={
                busy ||
                (step === 'discovery' && (!source || (source === 'other' && !details.trim())))
              }
              onClick={() => void run(() => advance(step === 'discovery' ? 'permissions' : 'mode'))}
            >
              {t('desktop.onboarding.continue')}
            </Button>
          )}
          {state === 'restarting' && (
            <p role="status" className="text-muted-foreground text-sm">
              {t('desktop.modeChooser.restarting')}
            </p>
          )}
        </>
      }
    >
      {step === 'discovery' && (
        <>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label={t('desktop.onboarding.discovery.title')}
          >
            {DISCOVERY_SOURCES.map(item => (
              <Button
                key={item}
                variant={source === item ? 'default' : 'outline'}
                aria-pressed={source === item}
                disabled={busy}
                onClick={() => setSource(item)}
              >
                {t(`desktop.onboarding.discovery.sources.${item}`)}
              </Button>
            ))}
          </div>
          {source === 'other' && (
            <Input
              className="mt-4"
              value={details}
              maxLength={200}
              disabled={busy}
              aria-label={t('desktop.onboarding.discovery.other')}
              placeholder={t('desktop.onboarding.discovery.other')}
              onChange={event => setDetails(event.target.value)}
            />
          )}
        </>
      )}
      {step === 'permissions' && <PermissionsSetting />}
      {step === 'mode' && <ModeChooser busy={busy} onChoose={choose} />}
    </OnboardingFrame>
  );
}
