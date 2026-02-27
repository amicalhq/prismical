import { CalendarDays, NotebookText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { NotesList } from "../../notes/components/notes-list";
import { getMeetingIcon } from "@/utils/meeting-icons";

type GreetingPeriod = "morning" | "afternoon" | "evening";

interface UpcomingMeeting {
  id: string;
  calendarColor: string;
  startTime: string;
  endTime: string;
  title: string;
  participantCount: number;
  meetingLabel: string;
  meetingUrl: string;
}

const UPCOMING_MEETINGS: UpcomingMeeting[] = [
  {
    id: "standup",
    calendarColor: "#34C759",
    startTime: "9:30 AM",
    endTime: "10:00 AM",
    title: "Product & Engineering Daily Standup",
    participantCount: 8,
    meetingLabel: "Google Meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  },
  {
    id: "design-review",
    calendarColor: "#0A84FF",
    startTime: "11:00 AM",
    endTime: "11:45 AM",
    title: "Desktop Home Experience Design Review",
    participantCount: 5,
    meetingLabel: "Zoom",
    meetingUrl: "https://zoom.us/j/123456789",
  },
  {
    id: "customer-sync",
    calendarColor: "#FF9F0A",
    startTime: "3:00 PM",
    endTime: "3:30 PM",
    title: "Customer Notes Workflow Sync",
    participantCount: 4,
    meetingLabel: "Microsoft Teams",
    meetingUrl: "https://teams.microsoft.com/l/meetup-join/123",
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
  const greetingPeriod = getGreetingPeriod(new Date());

  const handleOpenMeeting = (url: string) => {
    window.electronAPI.openExternal(url);
  };

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-bold">
          {t(`settings.home.greeting.${greetingPeriod}`)}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {t("settings.home.subtitle")}
        </p>
      </div>

      <div className="space-y-8 pb-8">
        <section className="space-y-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <CalendarDays className="w-4 h-4" />
            <h2 className="text-sm font-medium">
              {t("settings.home.upcoming.title")}
            </h2>
          </div>

          <div className="bg-accent/40 rounded-xl overflow-hidden">
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
                    {meeting.startTime} - {meeting.endTime}
                  </p>
                  <p className="text-sm font-medium leading-tight">
                    {meeting.title}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      {t("settings.home.upcoming.participants", {
                        count: meeting.participantCount,
                      })}
                    </span>
                    <span aria-hidden="true">•</span>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => handleOpenMeeting(meeting.meetingUrl)}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        {getMeetingIcon(meeting.meetingUrl, {
                          className: "h-3.5 w-3.5",
                        })}
                        <span>{meeting.meetingLabel}</span>
                      </span>
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <NotebookText className="w-4 h-4" />
            <h2 className="text-sm font-medium">{t("settings.nav.notes.title")}</h2>
          </div>
          <NotesList showPageHeader={false} />
        </section>
      </div>
    </div>
  );
}
