import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { NotesList } from "../../notes/components/notes-list";
import { getMeetingIcon } from "@/utils/meeting-icons";
import {
  formatEventTimeRange,
  getEventDateLabel,
} from "@/utils/event-time";
import { api } from "@/trpc/react";

type GreetingPeriod = "morning" | "afternoon" | "evening";

interface UpcomingMeeting {
  id: string;
  calendarColor: string;
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  title: string;
  meetingUrl: string | null;
  calendarEventUrl: string | null;
}

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

  const { data: upcomingEventRows } = api.events.getUpcoming.useQuery({
    limit: 3,
  });

  const upcomingMeetings: UpcomingMeeting[] = (upcomingEventRows ?? []).map(
    (event) => ({
      id: event.id,
      calendarColor: event.calendarColor,
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      title: event.title,
      meetingUrl: event.meetingUrl,
      calendarEventUrl: event.calendarEventUrl,
    }),
  );

  const createNoteFromEvent = api.notes.createNoteFromEvent.useMutation({
    onSuccess: (data) => {
      utils.notes.getNotes.invalidate();
      navigate({
        to: "/settings/notes/$noteId",
        params: { noteId: String(data.note.id) },
      });
    },
  });

  const handleOpenMeeting = (url: string | null) => {
    if (!url) return;
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
        meetingUrl: meeting.meetingUrl ?? undefined,
        calendarEventUrl: meeting.calendarEventUrl ?? undefined,
        startAt: meeting.startAt,
        endAt: meeting.endAt,
        isAllDay: meeting.isAllDay,
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
        {upcomingMeetings.length > 0 && (
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
              {upcomingMeetings.map((meeting) => (
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
                      {getEventDateLabel(meeting.startAt, t)}{" "}
                      <span aria-hidden="true">•</span>{" "}
                      {formatEventTimeRange(
                        meeting.startAt,
                        meeting.endAt,
                        meeting.isAllDay,
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-sm font-medium leading-tight text-left hover:underline cursor-pointer"
                        onClick={() =>
                          handleOpenMeeting(meeting.calendarEventUrl)
                        }
                      >
                        {meeting.title}
                      </button>
                      {meeting.meetingUrl
                        ? getMeetingIcon(meeting.meetingUrl, {
                            className:
                              "h-3.5 w-3.5 text-muted-foreground shrink-0",
                          })
                        : null}
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
                    {meeting.meetingUrl ? (
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs px-2.5 bg-primary text-primary-foreground hover:bg-primary/80 cursor-pointer"
                        onClick={() => handleOpenMeeting(meeting.meetingUrl)}
                      >
                        {t("settings.home.upcoming.join")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <NotesList showPageHeader={false} groupByDate />
      </div>
    </div>
  );
}
