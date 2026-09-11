import { eq } from 'drizzle-orm';
import {
  InitializeUserPreferencesRequestSchema,
  LANGUAGE_PREFERENCE_DEFAULTS,
  TRANSCRIPTION_PREFERENCE_DEFAULTS,
  UpdateUserPreferencesRequestSchema,
  readUserPreferences,
  type UserPreferences,
} from '@prismical/api-contracts/apps/v1';
import { userPreference } from '../../infra/product-db/schema';
import { invalidRequest, ok, type LocalDb, type RouteResult } from './wire';

const storedPreferences = (db: Pick<LocalDb, 'select'>): Record<string, unknown> =>
  db.select().from(userPreference).where(eq(userPreference.id, 1)).get()?.prefs ?? {};

export const getLocalPreferences = (db: LocalDb): UserPreferences =>
  readUserPreferences(storedPreferences(db));

/** Merge inside one immediate SQLite transaction so concurrent field edits keep both values. */
export function writeLocalPreferences(
  db: LocalDb,
  method: 'POST' | 'PATCH',
  body: unknown
): RouteResult {
  const parsed = method === 'POST'
    ? InitializeUserPreferencesRequestSchema.safeParse(body)
    : UpdateUserPreferencesRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('Invalid preferences');
  return db.transaction(tx => {
    const prefs = storedPreferences(tx);
    const next = { ...prefs };
    const defaults = { language: LANGUAGE_PREFERENCE_DEFAULTS, transcription: TRANSCRIPTION_PREFERENCE_DEFAULTS };
    for (const group of ['language', 'transcription'] as const) {
      const patch = parsed.data[group];
      if (!patch) continue;
      const previous = prefs[group];
      if (method === 'POST' && previous != null) continue;
      next[group] = {
        ...defaults[group],
        ...(typeof previous === 'object' && previous !== null ? previous : {}),
        ...patch,
      };
    }
    tx.insert(userPreference).values({ id: 1, prefs: next })
      .onConflictDoUpdate({ target: userPreference.id, set: { prefs: next } }).run();
    return ok(readUserPreferences(next));
  }, { behavior: 'immediate' });
}
