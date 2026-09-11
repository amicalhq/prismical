import { TRANSCRIPTION_LANGUAGE_CODES, type TranscriptionLanguage } from '@prismical/app-client';

/**
 * The display name of a spoken-language code in the interface locale, from the platform's own
 * language table (`Intl.DisplayNames`) so the list needs no hand-typed names.
 */
export function transcriptionLanguageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale, 'en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** How many leading codes of the shared list are "common" and keep their curated order. */
const COMMON = 14;

/** Every pickable spoken language: the common ones first in their curated order, the rest by name. */
export function transcriptionLanguageOptions(
  locale: string
): Array<{ code: TranscriptionLanguage; name: string }> {
  const named = TRANSCRIPTION_LANGUAGE_CODES.map(code => ({
    code,
    name: transcriptionLanguageName(code, locale),
  }));
  const rest = named.slice(COMMON).sort((a, b) => a.name.localeCompare(b.name, locale));
  return [...named.slice(0, COMMON), ...rest];
}
