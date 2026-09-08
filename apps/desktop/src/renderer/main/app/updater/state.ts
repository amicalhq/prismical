import { useEffect, useState } from 'react';
import type { UpdateAccessView, UpdateStateView } from '@prismical/desktop-contracts';

/** Subscribe first; a late pull must not replace a newer main-process push. */
function useSnapshot<T>(
  read: () => Promise<T>,
  subscribe: (listener: (value: T) => void) => () => void
) {
  const [state, setState] = useState<T | null>(null);
  useEffect(() => {
    let live = true;
    let pushed = false;
    const off = subscribe(value => {
      pushed = true;
      setState(value);
    });
    void read()
      .then(value => {
        if (live && !pushed) setState(value);
      })
      .catch(() => {});
    return () => {
      live = false;
      off();
    };
  }, [read, subscribe]);
  return state;
}

export const useUpdateAccess = () =>
  useSnapshot<UpdateAccessView>(
    window.desktop.capabilities.getUpdateAccess,
    window.desktop.capabilities.onUpdateAccess
  );
export const useUpdateView = () =>
  useSnapshot<UpdateStateView>(
    window.desktop.capabilities.getUpdateState,
    window.desktop.capabilities.onUpdateState
  );

export function useUpdateAction(action: () => Promise<unknown>) {
  const [isPending, setPending] = useState(false);
  const [isError, setError] = useState(false);
  return {
    isPending,
    isError,
    mutate: () => {
      setPending(true);
      setError(false);
      void action()
        .catch(() => setError(true))
        .finally(() => setPending(false));
    },
  };
}
