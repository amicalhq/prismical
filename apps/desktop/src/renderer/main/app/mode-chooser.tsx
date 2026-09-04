/**
 * The first-run mode chooser is desktop-owned; the shared library never sees it.
 *
 * Shown by the mode router (mount.tsx) while no mode was ever chosen. It paints
 * OVER the auth-gate root (a fresh install boots 'cloud' by default, so the
 * gate is mounted underneath — see index.ts) and calls main directly:
 *  - "Use on this device" → capability:chooseAppMode { mode: 'local' } — the
 *    mode differs from the boot mode, so main persists it and relaunches; the
 *    card shows a restarting state until the window goes away.
 *  - "Sign in or create an account" → { mode: 'cloud' } — equals the boot
 *    mode, so main persists it and answers { relaunch: false }; the chooser
 *    unmounts and the gate underneath owns the surface.
 * A persist failure surfaces as a notice; the chooser stays (a relaunch would
 * only show it again). Nothing here writes localStorage/sessionStorage (the
 * auth sentinel spec asserts renderer storage stays allowlisted).
 *
 * Frameless-window chrome: the same drag strip + no-drag card as the gate
 * (globals.css `.auth-gate-drag` / `.auth-gate-card`) — the gate's own strip
 * is underneath, but app-region rects never subtract by stacking, so the
 * chooser carries its own and keeps its buttons out of the top strip.
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppModeValue } from '@prismical/desktop-contracts';
import { Button } from '@prismical/app-ui/ui/button';
import { GateCard } from '../gate-card';

type ChooserState = 'choose' | 'applying' | 'restarting' | 'failed';

export function ModeChooser({ onChosen }: { onChosen: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<ChooserState>('choose');
  const busy = state === 'applying' || state === 'restarting';

  const choose = useCallback(
    (mode: AppModeValue): void => {
      if (busy) return;
      setState('applying');
      window.desktop.capabilities.chooseAppMode({ mode }).then(
        result => {
          if (result.relaunch) {
            // Main is quitting into the chosen mode; this window is on its way out.
            setState('restarting');
            return;
          }
          onChosen();
        },
        () => {
          setState('failed');
        }
      );
    },
    [busy, onChosen]
  );

  return (
    <div
      data-testid="mode-chooser"
      data-state={state}
      className="auth-gate bg-background text-foreground fixed inset-0 z-20 flex justify-center overflow-y-auto px-4 py-10"
    >
      <div className="auth-gate-drag" />
      <div className="auth-gate-card my-auto flex w-full max-w-md flex-col items-center">
        <GateCard wide brandTestId="mode-chooser-brand">
          <div className="grid gap-5 text-center">
            <div>
              <h2 className="text-base font-semibold">{t('desktop.modeChooser.title')}</h2>
              <p className="text-muted-foreground mt-1 text-sm leading-snug">
                {t('desktop.modeChooser.description')}
              </p>
            </div>
            <ModeOption
              title={t('desktop.modeChooser.local.title')}
              description={t('desktop.modeChooser.local.description')}
              action={t('desktop.modeChooser.local.choose')}
              testId="mode-choose-local"
              disabled={busy}
              onChoose={() => choose('local')}
            />
            <ModeOption
              title={t('desktop.modeChooser.cloud.title')}
              description={t('desktop.modeChooser.cloud.description')}
              action={t('desktop.modeChooser.cloud.choose')}
              testId="mode-choose-cloud"
              variant="outline"
              disabled={busy}
              onChoose={() => choose('cloud')}
            />
            {state === 'restarting' ? (
              <p data-testid="mode-chooser-notice" className="text-muted-foreground text-sm">
                {t('desktop.modeChooser.restarting')}
              </p>
            ) : null}
            {state === 'failed' ? (
              <p data-testid="mode-chooser-notice" className="text-destructive text-sm">
                {t('desktop.modeChooser.failed')}
              </p>
            ) : null}
          </div>
        </GateCard>
      </div>
    </div>
  );
}

function ModeOption({
  title,
  description,
  action,
  testId,
  variant = 'default',
  disabled,
  onChoose,
}: {
  title: string;
  description: string;
  action: string;
  testId: string;
  variant?: 'default' | 'outline';
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-4 text-left">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-sm leading-snug">{description}</p>
      <Button
        type="button"
        variant={variant}
        className="mt-1 w-full"
        data-testid={testId}
        disabled={disabled}
        onClick={onChoose}
      >
        {action}
      </Button>
    </div>
  );
}
