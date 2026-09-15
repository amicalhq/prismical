import type { TransportPort } from '@prismical/app-contracts';
import { LOCAL_WORKSPACE, type AppModeValue } from '@prismical/desktop-contracts';
import {
  AskSelectionSchema,
  type InitializeUserPreferencesRequest,
} from '@prismical/api-contracts/apps/v1';

const MIGRATED = 'prismical:local-account-preferences:v1:migrated';
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;

const jsonObject = (raw: string | null): Record<string, unknown> => {
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

/** Run before account preferences load. POST seeds missing local groups without replacing saved choices. */
export async function migrateLocalPreferences({
  appMode,
  getStorage,
  request,
}: {
  appMode: AppModeValue;
  getStorage: () => StorageAccess;
  request: TransportPort['request'];
}): Promise<void> {
  if (appMode !== 'local') return;
  let storage: StorageAccess;
  const body: InitializeUserPreferencesRequest = {};
  try {
    storage = getStorage();
    if (storage.getItem(MIGRATED) === '1') return;
    const experience: NonNullable<InitializeUserPreferencesRequest['experience']> = {};
    const enhance = storage.getItem('prismical:auto-enhance');
    if (enhance === '0' || enhance === '1') experience.autoEnhance = enhance === '1';
    const theme = storage.getItem('theme');
    if (theme === 'light' || theme === 'dark' || theme === 'system') experience.theme = theme;
    const recording = jsonObject(storage.getItem('prismical:recording-preferences:v1'));
    if (typeof recording.autoTranscribeNewNotes === 'boolean') {
      experience.autoTranscribeNewNotes = recording.autoTranscribeNewNotes;
    }
    if (Object.keys(experience).length > 0) body.experience = experience;
    const ask = jsonObject(storage.getItem('ask.model.v1'));
    const selection = AskSelectionSchema.safeParse({
      instanceId: ask.instanceId,
      modelId: ask.modelId,
    });
    if (selection.success) body.ask = { [LOCAL_WORKSPACE.orgId]: selection.data };
  } catch {
    // Storage can be blocked; there is then no usable legacy source to migrate.
    return;
  }
  if (Object.keys(body).length > 0) {
    const response = await request({ method: 'POST', path: '/apps/v1/me/preferences', body });
    if (!('ok' in response) || response.status < 200 || response.status >= 300) {
      throw new Error('Could not migrate local preferences');
    }
  }
  try {
    storage.setItem(MIGRATED, '1');
  } catch {
    // The database seed is already durable; repeating the write-once POST is safe.
  }
}
