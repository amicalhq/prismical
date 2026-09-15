'use client';
import { currentAccountExperience } from '../settings/account-experience-store';
import { useAccountExperience } from '../settings/account-experience-provider';

/** Do not run automatic AI work until the signed-in account's preference has loaded. */
export function getAutoEnhanceEnabled(): boolean {
  return currentAccountExperience()?.getSnapshot().data?.experience.autoEnhance ?? false;
}
export function setAutoEnhanceEnabled(on: boolean): void {
  currentAccountExperience()?.update({ experience: { autoEnhance: on } });
}
export function useAutoEnhanceEnabled(): [boolean, (on: boolean) => void] {
  const { data, update } = useAccountExperience();
  return [
    data?.experience.autoEnhance ?? false,
    on => {
      update?.({ experience: { autoEnhance: on } });
    },
  ];
}
