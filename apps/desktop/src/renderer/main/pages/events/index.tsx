import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { getMeetingIcon } from "@/utils/meeting-icons";
import {
  formatEventTimeRange,
  getEventDateLabel,
} from "@/utils/event-time";
import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import { api } from "@/trpc/react";

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

function getDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}


interface DateGroup {
  dateKey: string;
  label: string;
  date: Date;
  meetings: UpcomingMeeting[];
}

export default function EventsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();

  const { data: eventRows } = api.events.getUpcoming.useQuery();

  const allMeetings: UpcomingMeeting[] = useMemo(
    () =>
      (eventRows ?? []).map((event) => ({
        id: event.id,
        calendarColor: event.calendarColor,
        startAt: event.startAt,
        endAt: event.endAt,
        isAllDay: event.isAllDay,
        title: event.title,
        meetingUrl: event.meetingUrl,
        calendarEventUrl: event.calendarEventUrl,
      })),
    [eventRows],
  );

  const createNoteFromEvent = api.notes.createNoteFromEvent.useMutation({
    onSuccess: (data) => {
      utils.notes.getNotes.invalidate();
      navigate({
        to: "/notes/$noteId",
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

  const dateGroups = useMemo<DateGroup[]>(() => {
    const groups = new Map<string, DateGroup>();

    for (const meeting of allMeetings) {
      const key = getDateKey(meeting.startAt);
      if (!groups.has(key)) {
        groups.set(key, {
          dateKey: key,
          label: getEventDateLabel(meeting.startAt, t, {
            weekday: "long",
            month: "short",
            day: "numeric",
          }),
          date: meeting.startAt,
          meetings: [],
        });
      }
      groups.get(key)!.meetings.push(meeting);
    }

    return Array.from(groups.values()).sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }, [allMeetings, t]);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t("settings.events.title")}</h1>
      </div>

      {dateGroups.length === 0 ? (
        <div className="border border-dashed rounded-lg p-6 text-center space-y-4">
          <CalendarDays className="w-8 h-8 text-muted-foreground mx-auto" />
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("settings.events.empty.title")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.events.empty.description")}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6 pb-8">
          {dateGroups.map((group) => (
            <section key={group.dateKey} className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground px-1">
                {group.label}
              </h2>
              <div className="bg-accent/40 rounded-xl overflow-hidden">
                {group.meetings.map((meeting) => (
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
          ))}
        </div>
      )}
    </div>
  );
}
