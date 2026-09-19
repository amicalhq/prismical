import { eq } from 'drizzle-orm';
import {
  ACCOUNT_EXPERIENCE_DEFAULTS,
  InitializeUserPreferencesRequestSchema,
  LANGUAGE_PREFERENCE_DEFAULTS,
  TRANSCRIPTION_PREFERENCE_DEFAULTS,
  UpdateUserPreferencesRequestSchema,
  readUserPreferences,
  type UserPreferences,
  type UpdateUserPreferencesRequest,
} from '@prismical/api-contracts/apps/v1';
import { userPreference } from '../../infra/product-db/schema';
import { invalidRequest, ok, type LocalDb, type RouteResult } from './wire';

const storedPreferences = (db: Pick<LocalDb, 'select'>): Record<string, unknown> =>
  db.select().from(userPreference).where(eq(userPreference.id, 1)).get()?.prefs ?? {};

export const getLocalPreferences = (db: LocalDb): UserPreferences =>
  readUserPreferences(storedPreferences(db));

const defaults = {
  ...ACCOUNT_EXPERIENCE_DEFAULTS,
  language: LANGUAGE_PREFERENCE_DEFAULTS,
  transcription: TRANSCRIPTION_PREFERENCE_DEFAULTS,
};
const groups = Object.keys(defaults) as (keyof UpdateUserPreferencesRequest)[];
const latchOnce: Partial<Record<keyof UpdateUserPreferencesRequest, readonly string[]>> = {
  prompts: Object.keys(ACCOUNT_EXPERIENCE_DEFAULTS.prompts),
  welcome: Object.keys(ACCOUNT_EXPERIENCE_DEFAULTS.welcome),
  onboarding: ['replayRetired'],
};

const objectFields = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Merge inside one immediate SQLite transaction so concurrent field edits keep both values. */
export function writeLocalPreferences(
  db: LocalDb,
  method: 'POST' | 'PATCH',
  body: unknown
): RouteResult {
  const parsed =
    method === 'POST'
      ? InitializeUserPreferencesRequestSchema.safeParse(body)
      : UpdateUserPreferencesRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('Invalid preferences');
  return db.transaction(
    tx => {
      const prefs = storedPreferences(tx);
      const next = { ...prefs };
      for (const group of groups) {
        const patch = parsed.data[group];
        if (!patch) continue;
        const previous = prefs[group];
        if (method === 'POST' && previous != null) continue;
        const saved = objectFields(previous);
        const merged: Record<string, unknown> = {
          ...defaults[group],
          ...saved,
          ...patch,
        };
        if (method === 'PATCH') {
          // Prompt acknowledgments cannot be undone by a stale renderer's retry.
          for (const field of latchOnce[group] ?? []) {
            merged[field] = saved[field] === true || objectFields(patch)[field] === true;
          }
          if (group === 'onboarding' && 'walkthrough' in patch) {
            const incoming = objectFields(patch.walkthrough);
            const status = objectFields(saved.walkthrough).status;
            const replay = incoming.status === 'offered' && incoming.replay === true;
            if (
              !replay &&
              incoming.status !== 'completed' &&
              (status === 'completed' || status === 'dismissed')
            ) {
              merged.walkthrough = saved.walkthrough;
            }
          }
        }
        next[group] = merged;
      }
      tx.insert(userPreference)
        .values({ id: 1, prefs: next })
        .onConflictDoUpdate({ target: userPreference.id, set: { prefs: next } })
        .run();
      return ok(readUserPreferences(next));
    },
    { behavior: 'immediate' }
  );
}
