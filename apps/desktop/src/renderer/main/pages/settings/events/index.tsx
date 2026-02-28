import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { getMeetingIcon } from "@/utils/meeting-icons";
import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import { api } from "@/trpc/react";

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

function getDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function getDateLabel(date: Date, t: (key: string) => string): string {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  const diffDays = Math.round(
    (startOfDate.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24),
  );

  if (diffDays === 0) return t("settings.home.upcoming.today");
  if (diffDays === 1) return t("settings.home.upcoming.tomorrow");

  return new Intl.DateTimeFormat(
    typeof navigator !== "undefined"
      ? navigator.language
      : Intl.DateTimeFormat().resolvedOptions().locale,
    { weekday: "long", month: "short", day: "numeric" },
  ).format(date);
}

// TODO: Replace with real calendar data
const today = new Date();
const tomorrow = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate() + 1,
);
const dayAfter = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate() + 2,
);
const day3 = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate() + 3,
);
const day5 = new Date(
  today.getFullYear(),
  today.getMonth(),
  today.getDate() + 5,
);

const ALL_MEETINGS: UpcomingMeeting[] = [
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
    id: "1on1",
    calendarColor: "#34C759",
    date: today,
    startTime: "2:00 PM",
    endTime: "2:30 PM",
    title: "1:1 with Manager",
    meetingUrl: "https://meet.google.com/xyz-uvwx-yz",
    calendarEventUrl: "https://calendar.google.com/calendar/event?eid=xyz789",
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
  {
    id: "sprint-planning",
    calendarColor: "#0A84FF",
    date: day3,
    startTime: "10:00 AM",
    endTime: "11:00 AM",
    title: "Sprint Planning",
    meetingUrl: "https://meet.google.com/spr-plan-ing",
    calendarEventUrl: "https://calendar.google.com/calendar/event?eid=spr123",
  },
  {
    id: "all-hands",
    calendarColor: "#AF52DE",
    date: day5,
    startTime: "4:00 PM",
    endTime: "5:00 PM",
    title: "Company All-Hands",
    meetingUrl: "https://zoom.us/j/987654321",
    calendarEventUrl: "https://calendar.google.com/calendar/event?eid=ah456",
  },
];

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

  const dateGroups = useMemo<DateGroup[]>(() => {
    const groups = new Map<string, DateGroup>();

    for (const meeting of ALL_MEETINGS) {
      const key = getDateKey(meeting.date);
      if (!groups.has(key)) {
        groups.set(key, {
          dateKey: key,
          label: getDateLabel(meeting.date, t),
          date: meeting.date,
          meetings: [],
        });
      }
      groups.get(key)!.meetings.push(meeting);
    }

    return Array.from(groups.values()).sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }, [t]);

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-bold">
          {t("settings.events.title")}
        </h1>
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
                        {meeting.startTime} - {meeting.endTime}
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
                        {getMeetingIcon(meeting.meetingUrl, {
                          className:
                            "h-3.5 w-3.5 text-muted-foreground shrink-0",
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
          ))}
        </div>
      )}
    </div>
  );
}
