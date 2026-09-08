import { useSyncExternalStore } from 'react';
import type { PermissionKind, PermissionStatuses } from '@prismical/desktop-contracts';
export {
  allDayStillCurrent,
  eventDayKey,
  formatTime12,
} from '../../../../packages/app-client/src/event-time';

// Simulated external services; the preview imports the production UI unchanged.
const initial = {
  permissions: { microphone: 'not-determined', systemAudio: 'granted' } as PermissionStatuses,
  google: false,
  apple: false,
};
let state = initial;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;
const update = (patch: Partial<typeof state>) => {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
};
export const resetServices = () => update(initial);

const capabilities = {
  has: () => true,
  getPermissionStatus: async () => state.permissions,
  requestPermission: async (kind: PermissionKind) => {
    update({
      permissions: {
        ...state.permissions,
        [kind === 'microphone' ? 'microphone' : 'systemAudio']: 'granted',
      },
    });
    return state.permissions;
  },
  openSystemSettings: async () => {},
  enableAppleCalendar: async () => {
    update({ apple: true });
    return { permission: 'granted', state: 'ready', error: null };
  },
};
export const useDesktopCapabilities = () => capabilities;
export const useFeatureFlag = () => ({ enabled: true, isResolved: true });
export const useInvalidateConnections = () => () => {};
export function useConnections() {
  const current = useSyncExternalStore(subscribe, snapshot);
  return {
    data: [
      ...(current.google ? [{ provider: 'google', status: 'active' }] : []),
      ...(current.apple ? [{ provider: 'eventkit', status: 'active' }] : []),
    ],
  };
}
export function useConnectCalendar() {
  return {
    isPending: false,
    mutate: () => {
      setTimeout(() => {
        update({ google: true });
        window.dispatchEvent(new Event('blur'));
      }, 400);
    },
  };
}
