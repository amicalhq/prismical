'use client';

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { Driver } from 'driver.js';
import type { TourStep } from './state';

export type AnchorStep = 'create' | TourStep;
const anchors: Record<AnchorStep, string[]> = {
  create: ['new-note'],
  record: ['record-pending', 'record-start', 'record-open'],
  speak: [
    'record-pending',
    'record-saving',
    'record-retry',
    'transcript',
    'record-live-open',
    'record-open',
  ],
  stop: ['record-pending', 'record-saving', 'record-retry', 'record-stop', 'record-open'],
  transcript: ['transcript-wait', 'record-retry', 'transcript', 'record-open'],
  enhance: ['enhance', 'skill-status', 'transcript-wait', 'record-retry', 'record-open'],
  result: ['note-body'],
  review: ['review-controls'],
};
export function findTourAnchor(step: AnchorStep): HTMLElement | undefined {
  for (const name of anchors[step]) {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-onboarding="${name}"]`)
    );
    // Retry turns append to Ask; guide the newest status, never a previous failed attempt.
    if (name === 'skill-status') elements.reverse();
    for (const element of elements) {
      if (
        !element.closest('[inert], [aria-hidden="true"]') &&
        element.getClientRects().length &&
        getComputedStyle(element).visibility !== 'hidden'
      )
        return element;
    }
  }
}

/** Only the presentation is a tour: application success events own progression. */
export function AnchoredTour({
  step,
  onContinue,
  onExit,
  onError,
}: {
  step: AnchorStep;
  onContinue: () => void;
  onExit: () => void;
  onError?: (code: 'target_unavailable' | 'tour_load_failed') => void;
}) {
  const { t } = useTranslation();
  const actions = React.useRef({ onContinue, onExit, onError });
  React.useEffect(() => {
    actions.current = { onContinue, onExit, onError };
  }, [onContinue, onExit, onError]);
  React.useEffect(() => {
    let stopped = false;
    let instance: Driver | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let last: HTMLElement | undefined;
    let shown = false;
    let lastBounds = '';
    let lastAnchor: string | undefined;
    let missingSince: number | undefined = Date.now();
    void import('driver.js')
      .then(({ driver }) => {
        if (stopped) return;
        instance = driver({
          animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          duration: 180,
          overlayOpacity: 0.35,
          stagePadding: 7,
          stageRadius: 12,
          popoverClass: 'prismical-tour',
          allowKeyboardControl: false,
          disableActiveInteraction: false,
          overlayClickBehavior: () => {},
          onCloseClick: () => actions.current.onExit(),
          onNextClick: () => actions.current.onContinue(),
          onDoneClick: () => actions.current.onContinue(),
        });
        const render = () => {
          if (stopped) return;
          const element = findTourAnchor(step);
          // Measure continuous absence, not time since the target was first highlighted.
          // A reader may spend minutes on a step before opening the next dock face.
          if (element) missingSince = undefined;
          else missingSince ??= Date.now();
          const name = element?.dataset.onboarding;
          const rect = element?.getBoundingClientRect();
          const bounds = rect ? `${rect.x}:${rect.y}:${rect.width}:${rect.height}` : '';
          if (shown && element === last && name === lastAnchor) {
            // Dock morphs and async editor content move a target without a window resize.
            if (bounds !== lastBounds) instance?.refresh();
            lastBounds = bounds;
            return;
          }
          lastBounds = bounds;
          // Give route changes, editor sync and dock expansion time to mount the real target.
          if (!element && Date.now() - missingSince! < 1800) return;
          if (!element) actions.current.onError?.('target_unavailable');
          last = element;
          lastAnchor = name;
          shown = true;
          const presentation =
            name === 'record-pending'
              ? 'starting'
              : name === 'record-saving' || name === 'transcript-wait'
                ? 'waiting'
                : name === 'record-retry' || (name === 'record-open' && step !== 'record')
                  ? 'retry'
                  : name === 'skill-status'
                    ? 'generating'
                    : step;
          const explanatory = presentation === 'transcript' || presentation === 'result';
          instance?.highlight({
            element,
            popover: {
              title: t(`onboarding.tour.${presentation}.title`),
              description: element
                ? t(`onboarding.tour.${presentation}.body`)
                : t('onboarding.unavailable'),
              side: step === 'result' ? 'bottom' : 'top',
              align: 'center',
              showButtons: explanatory && element ? ['next', 'close'] : ['close'],
              nextBtnText: t('common.actions.continue'),
              onPopoverRender: popover => {
                popover.closeButton.setAttribute('aria-label', t('onboarding.close'));
                popover.wrapper.setAttribute('aria-label', t('onboarding.title'));
                // Visible on every action step: denied microphone, plan gates and errors always have an exit.
                const hint = document.createElement('p');
                hint.className = 'prismical-tour-hint';
                hint.textContent = t('onboarding.recovery');
                popover.description.append(hint);
              },
            },
          });
        };
        render();
        // DOM targets are stable attributes, never screen coordinates. Driver owns resize/scroll geometry.
        timer = setInterval(render, 200);
      })
      .catch(() => {
        if (!stopped) {
          actions.current.onError?.('tour_load_failed');
          actions.current.onExit();
        }
      });
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        actions.current.onExit();
      }
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      stopped = true;
      clearInterval(timer);
      instance?.destroy();
      window.removeEventListener('keydown', escape, true);
    };
  }, [step, t]);
  return null;
}
