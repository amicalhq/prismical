import { walkthroughKey } from './state';
import { currentAccountExperience } from '@prismical/app-client';
// Retirement follows the user, including when they delete notes or switch organizations.
export function replayAvailable(_userKey: string, noteCount: number): boolean {
  const account = currentAccountExperience();
  if (!account || _userKey !== walkthroughKey(account.userId)) return false;
  const saved = account?.getSnapshot().data?.onboarding;
  if (!saved) return false;
  if (noteCount >= 3 && !saved.replayRetired)
    account?.update({ onboarding: { replayRetired: true } });
  return noteCount < 3 && !saved.replayRetired;
}
