/**
 * The first-run mode chooser is desktop-owned; the shared library never sees it.
 *
 * Shown by the mode router (mount.tsx) while no mode was ever chosen. It paints
 * OVER the auth-gate root (a fresh install boots 'cloud' by default, so the
 * gate is mounted underneath — see index.ts) and calls main directly:
 *  - "Use without an account" → capability:chooseAppMode { mode: 'local' } — the
 *    mode differs from the boot mode, so main persists it and relaunches; the
 *    card shows a restarting state until the window goes away.
 *  - "Sign in with Prismical" → { mode: 'cloud' } — equals the boot
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
import { ShineBorder } from '@prismical/app-ui/ui/shine-border';
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
        <GateCard brandTestId="mode-chooser-brand">
          <div className="grid gap-3 text-center">
            <div className="relative rounded-md">
              <Button
                type="button"
                className="w-full"
                data-testid="mode-choose-cloud"
                disabled={busy}
                onClick={() => choose('cloud')}
              >
                {t('desktop.modeChooser.cloud.choose')}
              </Button>
              <ShineBorder shineColor={['#6366f1', '#a5b4fc', '#4f46e5']} borderWidth={2} />
            </div>
            <Button
              type="button"
              variant="link"
              className="text-muted-foreground hover:text-foreground justify-self-center text-xs font-normal"
              data-testid="mode-choose-local"
              disabled={busy}
              onClick={() => choose('local')}
            >
              {t('desktop.modeChooser.local.choose')}
            </Button>
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
