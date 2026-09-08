'use client';

import { useTranslation } from 'react-i18next';

import { providerTranscriptionCaveats } from '../../../../lib/providers';

/**
 * The things a user should know BEFORE they make a provider their dictation default: that it will
 * not label speakers, that a free key cannot keep up with a recording, and whatever the next
 * provider brings.
 *
 * One component rather than a block per dialog, because the caveats were previously written into
 * the "change default" dialog only - so the wizard, which is where a brand-new key actually gets
 * made the default, showed none of them. Anywhere a transcription model can be picked renders
 * this, and a new caveat reaches every one of them at once.
 */
export function TranscriptionCaveats({
  provider,
  providerLabel,
}: {
  /** Provider TYPE (e.g. "google-gemini"), not the instance label. */
  provider: string | undefined;
  /** Human-facing provider name, interpolated into the copy. */
  providerLabel: string;
}) {
  const { t } = useTranslation();
  const caveats = providerTranscriptionCaveats(provider ?? '');
  if (caveats.length === 0) return null;
  return (
    <>
      {caveats.map(key => (
        <p key={key} className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t(key, { provider: providerLabel })}
        </p>
      ))}
    </>
  );
}
