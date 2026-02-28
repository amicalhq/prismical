import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { NotesList } from "../../notes/components/notes-list";
import { getMeetingIcon } from "@/utils/meeting-icons";
import { api } from "@/trpc/react";

type GreetingPeriod = "morning" | "afternoon" | "evening";

interface UpcomingMeeting {
  id: string;
  calendarColor: string;
  date: Date;
  startTime: string;
  endTime: string;
  title: string;
  meetingUrl: string;
  calendarEventUrl: string;
}

function getMeetingDateLabel(date: Date, t: (key: string) => string): string {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (startOfDate.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) return t("settings.home.upcoming.today");
  if (diffDays === 1) return t("settings.home.upcoming.tomorrow");

  return new Intl.DateTimeFormat(
    typeof navigator !== "undefined"
      ? navigator.language
      : Intl.DateTimeFormat().resolvedOptions().locale,
    { month: "short", day: "numeric" },
  ).format(date);
}

const today = new Date();
const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
const dayAfter = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);

const UPCOMING_MEETINGS: UpcomingMeeting[] = [
  {
    id: "standup",
    calendarColor: "#34C759",
    date: today,
    startTime: "9:30 AM",
    endTime: "10:00 AM",
    title: "Product & Engineering Daily Standup",

    meetingUrl: "https://meet.google.com/abc-defg-hij",
    calendarEventUrl: "https://calendar.google.com/calendar/event?eid=abc123",
  },
  {
    id: "design-review",
    calendarColor: "#0A84FF",
    date: tomorrow,
    startTime: "11:00 AM",
    endTime: "11:45 AM",
    title: "Desktop Home Experience Design Review",

    meetingUrl: "https://zoom.us/j/123456789",
    calendarEventUrl: "https://calendar.google.com/calendar/event?eid=def456",
  },
  {
    id: "customer-sync",
    calendarColor: "#FF9F0A",
    date: dayAfter,
    startTime: "3:00 PM",
    endTime: "3:30 PM",
    title: "Customer Notes Workflow Sync",

    meetingUrl: "https://teams.microsoft.com/l/meetup-join/123",
    calendarEventUrl: "https://outlook.office365.com/calendar/item/ghi789",
  },
];

function getGreetingPeriod(date: Date): GreetingPeriod {
  const hour = date.getHours();

  if (hour < 12) {
    return "morning";
  }

  if (hour < 18) {
    return "afternoon";
  }

  return "evening";
}

export default function HomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();
  const greetingPeriod = getGreetingPeriod(new Date());

  const createNoteFromEvent = api.notes.createNoteFromEvent.useMutation({
    onSuccess: (data) => {
      utils.notes.getNotes.invalidate();
      navigate({
        to: "/settings/notes/$noteId",
        params: { noteId: String(data.note.id) },
      });
    },
  });

  const handleOpenMeeting = (url: string) => {
    window.electronAPI.openExternal(url);
  };

  const handleNotesForMeeting = (meeting: UpcomingMeeting) => {
    if (createNoteFromEvent.isPending) return;
    createNoteFromEvent.mutate({
      title: meeting.title,
      eventData: {
        eventId: meeting.id,
        title: meeting.title,
        calendarColor: meeting.calendarColor,
        meetingUrl: meeting.meetingUrl,
        calendarEventUrl: meeting.calendarEventUrl,
        startTime: meeting.startTime,
        endTime: meeting.endTime,
        date: meeting.date.toISOString(),
      },
    });
  };

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-bold">
          👋 {t(`settings.home.greeting.${greetingPeriod}`)}
        </h1>
      </div>

      <div className="space-y-8 pb-8">
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">
              {t("settings.home.upcoming.title")}
            </h2>
            <Link
              to="/settings/events"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("settings.home.upcoming.allEvents")} &rsaquo;
            </Link>
          </div>

          <div className="bg-accent/60 dark:bg-accent/40 rounded-xl overflow-hidden py-1">
            {UPCOMING_MEETINGS.map((meeting) => (
              <div
                key={meeting.id}
                className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-accent/60"
              >
                <span
                  className="mt-0.5 h-8 w-1.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: meeting.calendarColor }}
                />

                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {getMeetingDateLabel(meeting.date, t)} <span aria-hidden="true">•</span> {meeting.startTime} - {meeting.endTime}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="text-sm font-medium leading-tight text-left hover:underline cursor-pointer"
                      onClick={() => handleOpenMeeting(meeting.calendarEventUrl)}
                    >
                      {meeting.title}
                    </button>
                    {getMeetingIcon(meeting.meetingUrl, {
                      className: "h-3.5 w-3.5 text-muted-foreground shrink-0",
                    })}
                  </div>
                </div>

                <div className="hidden group-hover:flex items-center gap-1.5 shrink-0 self-center">
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs px-2.5 bg-indigo-500 text-white hover:bg-indigo-600 hover:text-white cursor-pointer"
                    onClick={() => handleNotesForMeeting(meeting)}
                  >
                    {t("settings.home.upcoming.notes")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs px-2.5 bg-primary text-primary-foreground hover:bg-primary/80 cursor-pointer"
                    onClick={() => handleOpenMeeting(meeting.meetingUrl)}
                  >
                    {t("settings.home.upcoming.join")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <NotesList showPageHeader={false} groupByDate />
      </div>
    </div>
  );
}
