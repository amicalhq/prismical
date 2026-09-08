'use client';

import * as React from 'react';
import { Mic, Pause } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RecordingNoticeCard } from './recording-notice-card';

/**
 * The "Still there?" grace prompt — web's rendering of the auto-pause machine's
 * `show-grace` effect, and a deliberate sibling of the desktop notify card. Chrome comes from
 * {@link RecordingNoticeCard}, which it shares with the session and quota notices; what is
 * specific to auto-pause is the two affordances and the countdown.
 *
 * The loader is COSMETIC. Authority over when the pause commits lives on the sample clock in
 * `@prismical/silence` (background tabs throttle timers but keep delivering audio), so if this
 * bar finishes early nothing happens until the audio actually agrees — the same split 166 uses
 * between its renderer animation and main-side expiry.
 *
 * Every affordance here except Pause resolves to "keep recording", including dismissing the
 * toast: touching it at all proves a human is present, which is exactly what the silence detector
 * was guessing at. (The session and quota notices deliberately do NOT share that rule — dismissing
 * one of those cannot buy more session or more allowance.)
 */
export function AutoPausePrompt({
  graceMs,
  onKeepRecording,
  onPause,
}: {
  graceMs: number;
  onKeepRecording: () => void;
  onPause: () => void;
}) {
  const { t } = useTranslation();
  return (
    <RecordingNoticeCard
      title={t('recording.autoPause.title')}
      description={t('recording.autoPause.description')}
      countdownMs={graceMs}
      actions={[
        {
          label: t('recording.autoPause.keepRecording'),
          onClick: onKeepRecording,
          icon: <Mic className="h-3.5 w-3.5" />,
          emphasis: true,
        },
        {
          label: t('recording.autoPause.pause'),
          onClick: onPause,
          icon: <Pause className="h-3.5 w-3.5" />,
        },
      ]}
    />
  );
}
