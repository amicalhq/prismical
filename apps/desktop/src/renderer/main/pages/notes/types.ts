export type UpcomingEvent = {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  meetingUrl: string;
  calendarEventUrl?: string;
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
    startAt: Date;
    endAt: Date;
    isAllDay: boolean;
  } | null;
}

export type NoteAssetKind = "transcription";

export type TranscriptionSpeaker = {
  index: number;
  name?: string;
  email?: string;
  isUser?: boolean;
};

export type TranscriptionSegment = {
  speaker: number;
  start: number;
  end: number;
  text: string;
};

export type TranscriptionData = {
  speakers: TranscriptionSpeaker[];
  segments: TranscriptionSegment[];
};
