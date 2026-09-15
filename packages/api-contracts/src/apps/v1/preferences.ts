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

/**
 * Spoken-language codes the transcription lanes accept: the languages Deepgram nova-3 serves as
 * monolingual models, every one of which whisper also knows. What each engine is actually told
 * for a pick is the wire mapping in `@prismical/ai` (Deepgram's multilingual mode for the ten it
 * covers, so a second language mid-meeting is kept). Ordered for the picker: common languages
 * first, then the rest by code.
 */
export const TRANSCRIPTION_LANGUAGE_CODES = [
  'en',
  'hi',
  'es',
  'fr',
  'de',
  'pt',
  'ja',
  'zh',
  'ko',
  'it',
  'nl',
  'ru',
  'ar',
  'tr',
  'af',
  'as',
  'be',
  'bg',
  'bn',
  'bs',
  'ca',
  'cs',
  'da',
  'el',
  'et',
  'fa',
  'fi',
  'gu',
  'he',
  'hr',
  'hu',
  'hy',
  'id',
  'ka',
  'kk',
  'kn',
  'lt',
  'lv',
  'mk',
  'mn',
  'mr',
  'ms',
  'ne',
  'no',
  'pa',
  'pl',
  'ps',
  'ro',
  'sk',
  'sl',
  'sr',
  'sv',
  'ta',
  'te',
  'th',
  'tl',
  'uk',
  'ur',
  'vi',
] as const;
export const TranscriptionLanguageSchema = z.enum(TRANSCRIPTION_LANGUAGE_CODES);
export type TranscriptionLanguage = z.output<typeof TranscriptionLanguageSchema>;
/** The `transcription` group: the language spoken in the user's recordings. */
export const TranscriptionPreferencesSchema = z
  .object({ language: TranscriptionLanguageSchema })
  .strict();
export type TranscriptionPreferences = z.output<typeof TranscriptionPreferencesSchema>;
export const TRANSCRIPTION_PREFERENCE_DEFAULTS: TranscriptionPreferences = Object.freeze({
  language: 'en',
});

/** Account-wide behavior; hardware choices remain on the device. */
export const ExperiencePreferencesSchema = z
  .object({
    autoEnhance: z.boolean(),
    autoTranscribeNewNotes: z.boolean(),
    theme: z.enum(['light', 'dark', 'system']),
  })
  .strict();
export type ExperiencePreferences = z.output<typeof ExperiencePreferencesSchema>;
export const EXPERIENCE_PREFERENCE_DEFAULTS: ExperiencePreferences = {
  autoEnhance: true,
  autoTranscribeNewNotes: false,
  theme: 'system',
};
export const AskSelectionSchema = z
  .object({
    instanceId: z.string().min(1).max(200),
    modelId: z.string().min(1).max(200),
  })
  .strict();
// A patch contains only the changed organization; the server merges these keys atomically.
export const AskPreferencesSchema = z.record(z.string().min(1).max(200), AskSelectionSchema);
export const WalkthroughSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('offered'),
      replay: z.boolean().optional(),
      started: z.boolean().optional(),
    })
    .strict(),
  z.object({ status: z.literal('dismissed') }).strict(),
  z.object({ status: z.literal('completed') }).strict(),
  z
    .object({
      status: z.literal('active'),
      orgId: z.string().min(1).max(200),
      noteId: z.string().min(1).max(200),
      step: z.enum(['record', 'speak', 'stop', 'transcript', 'enhance', 'result', 'review']),
      recordingId: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);
export type AccountWalkthrough = z.output<typeof WalkthroughSchema>;
export const OnboardingPreferencesSchema = z
  .object({
    walkthrough: WalkthroughSchema.nullable(),
    replayRetired: z.boolean(),
  })
  .strict();
export const ONBOARDING_PREFERENCE_DEFAULTS = { walkthrough: null, replayRetired: false } as const;
export const PromptPreferencesSchema = z
  .object({
    getAppsSeen: z.boolean(),
    calendarDismissed: z.boolean(),
  })
  .strict();
export const PROMPT_PREFERENCE_DEFAULTS = { getAppsSeen: false, calendarDismissed: false };
export const AccountExperienceSchema = z.object({
  experience: ExperiencePreferencesSchema,
  ask: AskPreferencesSchema,
  onboarding: OnboardingPreferencesSchema,
  prompts: PromptPreferencesSchema,
});
export type AccountExperience = z.output<typeof AccountExperienceSchema>;
export const ACCOUNT_EXPERIENCE_DEFAULTS: AccountExperience = {
  experience: EXPERIENCE_PREFERENCE_DEFAULTS,
  ask: {},
  onboarding: ONBOARDING_PREFERENCE_DEFAULTS,
  prompts: PROMPT_PREFERENCE_DEFAULTS,
};
// Native IPC preserves explicit undefined fields; reject them like an invalid JSON request.
const hasDefinedFields = (value: object) =>
  Object.keys(value).length > 0 && Object.values(value).every(field => field !== undefined);

const experiencePatch = {
  experience: ExperiencePreferencesSchema.partial()
    .refine(hasDefinedFields, 'Choose a preference to update')
    .optional(),
  ask: AskPreferencesSchema.optional(),
  onboarding: OnboardingPreferencesSchema.partial()
    .refine(hasDefinedFields, 'Choose an onboarding field to update')
    .optional(),
  prompts: PromptPreferencesSchema.partial()
    .refine(hasDefinedFields, 'Choose a prompt to update')
    .optional(),
};

/** Every preference group. A single resource, fields exposed directly (apps/v1 convention). */
export const UserPreferencesSchema = z
  .object({
    language: LanguagePreferencesSchema.nullable(),
    experience: ExperiencePreferencesSchema.nullable().default(null),
    ask: AskPreferencesSchema.nullable().default(null),
    onboarding: OnboardingPreferencesSchema.nullable().default(null),
    prompts: PromptPreferencesSchema.nullable().default(null),
    transcription: TranscriptionPreferencesSchema.nullable(),
  })
  .strip();
export type UserPreferences = z.output<typeof UserPreferencesSchema>;
export const UserPreferencesResponseSchema = UserPreferencesSchema;

/**
 * `POST`: seed the groups a device detected, write-once. A group the account already saved is left
 * untouched, so two devices racing on first sign-in keep the first choice. Each group names only the
 * fields a client can detect; the rest come from that group's defaults.
 */
export const InitializeUserPreferencesRequestSchema = z
  .object({
    ...experiencePatch,
    language: z.object({ interfaceLanguage: InterfaceLanguageSchema }).strict().optional(),
    transcription: TranscriptionPreferencesSchema.optional(),
  })
  .strict()
  .refine(hasDefinedFields, 'Choose a preference group to initialize');
export type InitializeUserPreferencesRequest = z.input<
  typeof InitializeUserPreferencesRequestSchema
>;

/** `PATCH`: merge the given fields into each named group, atomically. */
export const UpdateUserPreferencesRequestSchema = z
  .object({
    ...experiencePatch,
    ask: AskPreferencesSchema.refine(
      hasDefinedFields,
      'Choose an organization model to update'
    ).optional(),
    language: LanguagePreferencesSchema.partial()
      .refine(hasDefinedFields, 'Choose a language preference to update')
      .optional(),
    transcription: TranscriptionPreferencesSchema.partial()
      .refine(hasDefinedFields, 'Choose a transcription preference to update')
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

/** The saved `transcription` group, or null when never initialized (or invalid). */
export function readTranscriptionPreferences(prefs: unknown): TranscriptionPreferences | null {
  const value =
    typeof prefs === 'object' && prefs !== null && 'transcription' in prefs
      ? prefs.transcription
      : undefined;
  const parsed = TranscriptionPreferencesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readGroup<T>(prefs: unknown, key: string, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(
    prefs && typeof prefs === 'object' ? (prefs as Record<string, unknown>)[key] : undefined
  );
  return parsed.success ? parsed.data : null;
}

/** Project the raw `user.prefs` jsonb onto the typed resource; unknown/legacy keys are ignored. */
export function readUserPreferences(prefs: unknown): UserPreferences {
  return {
    experience: readGroup(prefs, 'experience', ExperiencePreferencesSchema),
    ask: readGroup(prefs, 'ask', AskPreferencesSchema),
    onboarding: readGroup(prefs, 'onboarding', OnboardingPreferencesSchema),
    prompts: readGroup(prefs, 'prompts', PromptPreferencesSchema),
    language: readLanguagePreferences(prefs),
    transcription: readTranscriptionPreferences(prefs),
  };
}

/** The language a skill run should write in for these preferences. */
export function resolveOutputLanguage(preferences: LanguagePreferences): SkillOutputLanguage {
  return preferences.aiOutputLanguage;
}
