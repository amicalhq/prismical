import {
  ACCOUNT_EXPERIENCE_DEFAULTS,
  AccountExperienceSchema,
  UserPreferencesSchema,
  UpdateUserPreferencesRequestSchema,
  type AccountExperience,
} from '@prismical/api-contracts/apps/v1';

export type ExperiencePatch = {
  [K in keyof AccountExperience]?: Partial<AccountExperience[K]>;
};
type Snapshot = { data: AccountExperience | null; error: boolean; pending: boolean };
type Transport = {
  get: () => Promise<unknown>;
  patch: (patch: ExperiencePatch) => Promise<unknown>;
};
// Web Locks coordinate tabs/windows sharing an origin. The fallback serializes stores in one
// renderer when storage or Web Locks is unavailable (for example in a test environment).
const localLocks = new Map<string, Promise<unknown>>();
async function withPreferenceLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(key, run);
  const previous = localLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  localLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (localLocks.get(key) === current) localLocks.delete(key);
  }
}
const groups = ['experience', 'ask', 'onboarding', 'prompts'] as const;
function merge(data: AccountExperience, patch: ExperiencePatch): AccountExperience {
  const next = { ...data };
  for (const key of groups) {
    if (patch[key]) Object.assign(next, { [key]: { ...data[key], ...patch[key] } });
  }
  const previous = data.onboarding.walkthrough;
  const incoming = patch.onboarding?.walkthrough;
  const replay = incoming?.status === 'offered' && incoming.replay === true;
  if (
    (previous?.status === 'completed' || previous?.status === 'dismissed') &&
    !replay &&
    incoming?.status !== 'completed'
  ) {
    next.onboarding = { ...next.onboarding, walkthrough: previous };
  }
  next.onboarding = {
    ...next.onboarding,
    replayRetired: data.onboarding.replayRetired || next.onboarding.replayRetired,
  };
  next.prompts = {
    getAppsSeen: data.prompts.getAppsSeen || next.prompts.getAppsSeen,
    calendarDismissed: data.prompts.calendarDismissed || next.prompts.calendarDismissed,
  };
  return next;
}
function project(raw: unknown): AccountExperience {
  const parsed = UserPreferencesSchema.parse(raw);
  return AccountExperienceSchema.parse(
    Object.fromEntries(groups.map(key => [key, parsed[key] ?? ACCOUNT_EXPERIENCE_DEFAULTS[key]]))
  );
}
function read(storage: Storage | undefined, key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function json(raw: string | null): unknown {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** One store per signed-in session. A durable per-user outbox is a cache, never the source of truth. */
export class AccountExperienceStore {
  private snapshot: Snapshot = { data: null, error: false, pending: false };
  private listeners = new Set<() => void>();
  private queue: { id: string; patch: ExperiencePatch; durable: boolean }[] = [];
  private running = false;
  private disposed = false;
  private sequence = 0;
  private confirmed: AccountExperience | null = null;
  private readonly outbox: string;
  constructor(
    readonly userId: string,
    private transport: Transport,
    private storage?: Storage
  ) {
    this.outbox = `account-preferences:pending:v1:${encodeURIComponent(userId)}`;
    // Each operation has its own key; another tab cannot erase this tab's unsent writes.
    try {
      const keys = Array.from({ length: storage?.length ?? 0 }, (_, i) => storage!.key(i))
        .filter((key): key is string => !!key && key.startsWith(`${this.outbox}:`))
        .sort();
      for (const id of keys) {
        const parsed = UpdateUserPreferencesRequestSchema.safeParse(json(read(storage, id)));
        if (parsed.success) {
          const patch = Object.fromEntries(
            groups.filter(key => parsed.data[key]).map(key => [key, parsed.data[key]])
          );
          if (Object.keys(patch).length) this.queue.push({ id, patch, durable: true });
        }
      }
    } catch {
      /* No durable outbox when storage is unavailable. */
    }
  }
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(error = false) {
    this.snapshot = {
      data: this.confirmed
        ? this.queue.reduce((data, item) => merge(data, item.patch), this.confirmed)
        : null,
      error,
      pending: this.queue.length > 0,
    };
    this.listeners.forEach(fn => fn());
  }
  update = (patch: ExperiencePatch): boolean => {
    if (this.disposed || !this.confirmed) return false;
    // Validate the resulting shape, not just the caller's TypeScript types.
    AccountExperienceSchema.parse(merge(this.snapshot.data!, patch));
    const item = {
      id: `${this.outbox}:${Date.now()}:${String(this.sequence++).padStart(8, '0')}:${crypto.randomUUID()}`,
      patch,
      durable: false,
    };
    this.queue.push(item);
    try {
      this.storage?.setItem(item.id, JSON.stringify(patch));
      item.durable = !!this.storage;
    } catch {
      /* Retry in memory. */
    }
    this.publish();
    void this.refresh();
    return true;
  };
  refresh = async () => {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      await withPreferenceLock(this.outbox, async () => {
        if (this.disposed) return;
        // A different tab may already have delivered an operation copied at construction. Check
        // under the shared lock before sending it again; an old copy must not undo a newer edit.
        this.queue = this.queue.filter(item => {
          if (!item.durable || !this.storage) return true;
          try {
            return this.storage.getItem(item.id) !== null;
          } catch {
            return true;
          }
        });
        if (!this.confirmed || !this.queue.length) {
          const raw = await this.transport.get();
          if (this.disposed) return;
          // Missing groups use defaults in memory; visiting the app does not seed them.
          this.confirmed = project(raw);
          this.publish();
        }
        while (this.queue.length && !this.disposed) {
          const item = this.queue[0]!;
          const response = await this.transport.patch(item.patch);
          const confirmed = project(response);
          // An account switch must not leave an acknowledged write behind for a later retry.
          try {
            this.storage?.removeItem(item.id);
          } catch {
            /* Storage may have become unavailable after the request started. */
          }
          if (this.disposed) return;
          this.confirmed = confirmed;
          this.queue.shift();
          this.publish();
        }
      });
    } catch {
      if (!this.disposed) this.publish(true);
    } finally {
      this.running = false;
    }
  };
  dispose() {
    this.disposed = true;
  }
}

let active: AccountExperienceStore | null = null;
export function bindAccountExperience(store: AccountExperienceStore) {
  active = store;
  return () => {
    if (active === store) active = null;
  };
}
/** Recording code outside React reads only the current session's store. */
export function currentAccountExperience() {
  return active;
}
