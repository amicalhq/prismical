import { walkthroughKey } from './state';
import { currentAccountExperience } from '@prismical/app-client';

/** Explicit Help-menu replay stays available after onboarding is completed. */
export function replayAvailable(userKey: string): boolean {
  const account = currentAccountExperience();
  return !!account && userKey === walkthroughKey(account.userId) && !!account.getSnapshot().data;
}
