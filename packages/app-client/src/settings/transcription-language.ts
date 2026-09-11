import {
  TRANSCRIPTION_LANGUAGE_CODES,
  TranscriptionLanguageSchema,
  type TranscriptionLanguage,
} from '@prismical/api-contracts/apps/v1';

/** Locale tags whose base is not the code the lanes use. */
const LOCALE_ALIASES: Record<string, string> = {
  nb: 'no',
  nn: 'no',
  fil: 'tl',
  iw: 'he',
  in: 'id',
  yue: 'zh',
  cmn: 'zh',
};

/**
 * The spoken language a device should propose for an account that never chose one.
 *
 * A legacy explicit pick (the old device-local "auto-detect off + language" setting) wins, so an
 * upgrade keeps what the user had deliberately set. Otherwise the device locale's base language,
 * when the transcription lanes know it; English when they do not. The account may reject the
 * proposal (another device seeded first) — the server's write-once POST decides.
 */
export function guessTranscriptionLanguage(
  systemLocale?: string | null,
  legacy?: { autoDetectLanguage: boolean; language: string } | null
): TranscriptionLanguage {
  if (legacy && !legacy.autoDetectLanguage) {
    const pick = TranscriptionLanguageSchema.safeParse(legacy.language);
    if (pick.success) return pick.data;
  }
  const base = systemLocale?.split(/[-_]/)[0]?.toLowerCase() ?? '';
  const fromLocale = TranscriptionLanguageSchema.safeParse(LOCALE_ALIASES[base] ?? base);
  return fromLocale.success ? fromLocale.data : 'en';
}

export function isTranscriptionLanguage(value: unknown): value is TranscriptionLanguage {
  return TranscriptionLanguageSchema.safeParse(value).success;
}

// The account's choice, readable outside React: the recording controllers create a recording
// from inside async work that has no context, and a shell may not mount the preferences provider
// at all. The provider publishes here; readers wait briefly while the account is loading and fall
// back to a device guess only when there is no account answer to wait for.
type Store =
  | { state: 'absent' }
  | { state: 'loading' }
  | { state: 'ready'; value: TranscriptionLanguage };
let store: Store = { state: 'absent' };
let waiters: Array<() => void> = [];
function settle(): void {
  const pending = waiters;
  waiters = [];
  for (const wake of pending) wake();
}
/** The provider mounted and is fetching the account; readers should wait rather than guess. */
export function markTranscriptionLanguageLoading(): void {
  store = { state: 'loading' };
}
/** The account answered. */
export function publishTranscriptionLanguage(language: TranscriptionLanguage): void {
  store = { state: 'ready', value: language };
  settle();
}
/** No provider (signed out, provider unmounted): readers guess from the device. */
export function clearTranscriptionLanguage(): void {
  store = { state: 'absent' };
  settle();
}
function deviceGuess(legacy?: { autoDetectLanguage: boolean; language: string } | null) {
  return guessTranscriptionLanguage(
    typeof navigator === 'undefined' ? undefined : navigator.language,
    legacy
  );
}
/** The account's spoken language right now, or a device guess while the account is unknown. */
export function currentTranscriptionLanguage(
  legacy?: { autoDetectLanguage: boolean; language: string } | null
): TranscriptionLanguage {
  return store.state === 'ready' ? store.value : deviceGuess(legacy);
}
/**
 * The account's spoken language for a recording about to start: waits (bounded) for an account
 * that is still loading, so a user who hits Record right after sign-in is not recorded in a
 * device guess that contradicts the account. The bound is short because the microphone is not
 * open yet while this waits; a later answer still reaches a running recording through the
 * mid-recording language change.
 */
export const TRANSCRIPTION_LANGUAGE_WAIT_MS = 1_500;
export async function resolveTranscriptionLanguage(
  legacy?: { autoDetectLanguage: boolean; language: string } | null,
  timeoutMs = TRANSCRIPTION_LANGUAGE_WAIT_MS
): Promise<TranscriptionLanguage> {
  if (store.state === 'loading') {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        waiters = waiters.filter(w => w !== wake);
        resolve();
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(wake);
    });
  }
  return currentTranscriptionLanguage(legacy);
}

export { TRANSCRIPTION_LANGUAGE_CODES };
