'use client';
import * as React from 'react';
import { apiClient, ME_PREFIX } from '../api/client';
import { useActiveAccountId, useActiveSessionKey, usePorts } from '../ports-context';
import { AccountExperienceStore, bindAccountExperience } from './account-experience-store';

const Context = React.createContext<AccountExperienceStore | null>(null);
const empty = { data: null, error: false, pending: false } as const;
const noop = () => () => {};
export function useAccountExperience() {
  const store = React.useContext(Context);
  const snapshot = React.useSyncExternalStore(
    store?.subscribe ?? noop,
    store?.getSnapshot ?? (() => empty),
    () => empty
  );
  return { ...snapshot, store, update: store?.update, retry: store?.refresh };
}
export function AccountExperienceProvider({ children }: { children: React.ReactNode }) {
  const session = useActiveSessionKey();
  const user = useActiveAccountId();
  return user && session ? (
    <ScopedExperience key={session} userId={user} sessionKey={session}>
      {children}
    </ScopedExperience>
  ) : (
    children
  );
}
function ScopedExperience({
  children,
  userId,
  sessionKey,
}: {
  children: React.ReactNode;
  userId: string;
  sessionKey: string;
}) {
  const { auth } = usePorts();
  const [store, setStore] = React.useState<AccountExperienceStore | null>(null);
  React.useLayoutEffect(() => {
    const assertOwner = () => {
      const session = auth.getSession();
      if ((session.activeSessionKey ?? session.activeSub) !== sessionKey)
        throw new Error('The active account changed');
    };
    let storage: Storage | undefined;
    try {
      storage = window.localStorage;
    } catch {
      /* optional cache */
    }
    const path = `${ME_PREFIX}/preferences`;
    const next = new AccountExperienceStore(
      userId,
      {
        get: () => {
          assertOwner();
          return apiClient.getRaw(path, undefined, { activeOrgId: null });
        },
        patch: patch => {
          assertOwner();
          return apiClient.patchRaw(path, patch, { activeOrgId: null });
        },
      },
      storage
    );
    const unbind = bindAccountExperience(next);
    setStore(next);
    void next.refresh();
    const interval = window.setInterval(() => void next.refresh(), 30_000);
    const refresh = () => void next.refresh();
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      next.dispose();
      unbind();
      window.clearInterval(interval);
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [userId, sessionKey, auth]);
  return (
    <Context.Provider value={store}>
      <ThemeBridge />
      {children}
    </Context.Provider>
  );
}
function ThemeBridge() {
  const { data } = useAccountExperience();
  const theme = data?.experience.theme;
  React.useEffect(() => {
    if (!theme) return;
    try {
      localStorage.setItem('theme', theme);
    } catch {
      /* initial-paint cache only */
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        theme === 'dark' || (theme === 'system' && mq.matches)
      );
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return null;
}
