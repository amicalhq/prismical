'use client';

import { useFeatureFlag } from '@prismical/app-client';
import { NotesList } from '../components/notes-list';
import { UpcomingMeetings } from '../components/upcoming-meetings';
import { HomeGreeting } from './home-greeting';

// Home screen: the greeting, an "Upcoming meetings" list, then the
// date-grouped notes list. The greeting's request-time logic was re-expressed
// as the client <HomeGreeting> so this screen carries no force-dynamic RSC.
export function HomeScreen() {
  // Calendars are an org feature (off in the desktop local workspace).
  const { enabled: calendarEnabled } = useFeatureFlag('calendar');
  return (
    <div className="mx-auto w-full" style={{ maxWidth: 'var(--content-width-browse)' }}>
      <div className="mb-8">
        <HomeGreeting />
      </div>

      <div className="space-y-8 pb-8">
        {calendarEnabled && <UpcomingMeetings limit={3} />}
        <NotesList showPageHeader={false} groupByDate />
      </div>
    </div>
  );
}
