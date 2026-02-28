export type UpcomingEvent = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  meetingUrl: string;
  calendarEventUrl?: string;
  date: Date;
  calendarColor?: string;
};

export interface Note {
  id: number;
  title: string;
  icon?: string | null;
  starred?: boolean;
  folder?: string | null;
  updatedAt: Date;
  eventData?: {
    eventId: string;
    title: string;
    calendarColor: string;
    meetingUrl?: string;
    calendarEventUrl?: string;
    startTime?: string;
    endTime?: string;
    date?: string;
  } | null;
}

export type NoteAssetKind = "transcription";
