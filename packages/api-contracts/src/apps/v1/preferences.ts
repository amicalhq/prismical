import { z } from 'zod';

/**
 * Account preferences (`GET`/`POST`/`PATCH /apps/v1/me/preferences`).
 *
 * One resource, grouped by concern. Every group is `null` until the account initializes it, so a
 * fresh device can tell "never chosen" from "chose the default". Groups are added here (and in the
 * route's group registry) rather than as new endpoints; the storage is the `user.prefs` jsonb.
 */

export const InterfaceLanguageSchema = z.enum(['en', 'de', 'es', 'ja', 'zh-TW']);
export type InterfaceLanguage = z.output<typeof InterfaceLanguageSchema>;

// Autonyms keep the picker usable even when the interface is in an unfamiliar language.
export const OUTPUT_LANGUAGES = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  ja: '日本語',
  'zh-TW': '繁體中文',
  'zh-CN': '简体中文',
  fr: 'Français',
  hi: 'हिन्दी',
  pt: 'Português',
  it: 'Italiano',
  ko: '한국어',
  ar: 'العربية',
  nl: 'Nederlands',
  pl: 'Polski',
  ru: 'Русский',
  uk: 'Українська',
  tr: 'Türkçe',
  vi: 'Tiếng Việt',
  id: 'Bahasa Indonesia',
  th: 'ไทย',
  sv: 'Svenska',
  da: 'Dansk',
  fi: 'Suomi',
  nb: 'Norsk bokmål',
  cs: 'Čeština',
  el: 'Ελληνικά',
  he: 'עברית',
  ro: 'Română',
  hu: 'Magyar',
  bn: 'বাংলা',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  mr: 'मराठी',
  pa: 'ਪੰਜਾਬੀ',
  ur: 'اردو',
} as const;
export const OutputLanguageSchema = z.enum(
  Object.keys(OUTPUT_LANGUAGES) as [
    keyof typeof OUTPUT_LANGUAGES,
    ...Array<keyof typeof OUTPUT_LANGUAGES>,
  ]
);
export type OutputLanguage = z.output<typeof OutputLanguageSchema>;

/**
 * What Skills write in. `'source'` keeps the note's own language (the behaviour before this
 * preference existed, and the default: nobody's notes change language because they never opened
 * a setting); a code pins a language and translates into it. Deliberately independent of the
 * interface language: reading the app in German says nothing about the language of a meeting.
 */
export const AiOutputLanguageSchema = z.union([z.literal('source'), OutputLanguageSchema]);
export type AiOutputLanguage = z.output<typeof AiOutputLanguageSchema>;
/** The language a skill run is asked to write in: a code, or `'source'` to match the note. */
export type SkillOutputLanguage = OutputLanguage | 'source';

/** The `language` group: interface locale + the language Skills write in. */
export const LanguagePreferencesSchema = z
  .object({
    interfaceLanguage: InterfaceLanguageSchema,
    aiOutputLanguage: AiOutputLanguageSchema,
  })
  .strict();
export type LanguagePreferences = z.output<typeof LanguagePreferencesSchema>;
/** Fills a partially saved group so a read always yields a complete object. */
export const LANGUAGE_PREFERENCE_DEFAULTS: LanguagePreferences = Object.freeze({
  interfaceLanguage: 'en',
  aiOutputLanguage: 'source',
});

/** Every preference group. A single resource, fields exposed directly (apps/v1 convention). */
export const UserPreferencesSchema = z
  .object({
    language: LanguagePreferencesSchema.nullable(),
  })
  .strip();
export type UserPreferences = z.output<typeof UserPreferencesSchema>;
export const UserPreferencesResponseSchema = UserPreferencesSchema;

// Native IPC preserves explicit undefined fields; reject them like an invalid JSON request.
const hasDefinedFields = (value: object) =>
  Object.keys(value).length > 0 && Object.values(value).every(field => field !== undefined);

/**
 * `POST`: seed the groups a device detected, write-once. A group the account already saved is left
 * untouched, so two devices racing on first sign-in keep the first choice. Each group names only the
 * fields a client can detect; the rest come from that group's defaults.
 */
export const InitializeUserPreferencesRequestSchema = z
  .object({
    language: z.object({ interfaceLanguage: InterfaceLanguageSchema }).strict().optional(),
  })
  .strict()
  .refine(hasDefinedFields, 'Choose a preference group to initialize');
export type InitializeUserPreferencesRequest = z.input<
  typeof InitializeUserPreferencesRequestSchema
>;

/** `PATCH`: merge the given fields into each named group, atomically. */
export const UpdateUserPreferencesRequestSchema = z
  .object({
    language: LanguagePreferencesSchema.partial()
      .refine(hasDefinedFields, 'Choose a language preference to update')
      .optional(),
  })
  .strict()
  .refine(hasDefinedFields, 'Choose a preference to update');
export type UpdateUserPreferencesRequest = z.input<typeof UpdateUserPreferencesRequestSchema>;

/** The saved `language` group, or null when the account never initialized it (or it is invalid). */
export function readLanguagePreferences(prefs: unknown): LanguagePreferences | null {
  const value =
    typeof prefs === 'object' && prefs !== null && 'language' in prefs ? prefs.language : undefined;
  const parsed = LanguagePreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Project the raw `user.prefs` jsonb onto the typed resource; unknown/legacy keys are ignored. */
export function readUserPreferences(prefs: unknown): UserPreferences {
  return { language: readLanguagePreferences(prefs) };
}

/** The language a skill run should write in for these preferences. */
export function resolveOutputLanguage(preferences: LanguagePreferences): SkillOutputLanguage {
  return preferences.aiOutputLanguage;
}
