import { Calendar, CalendarX, CalendarPlus } from "lucide-react";
import UpcomingEventCard from "./upcoming-event-card";
import { UpcomingEvent } from "../types";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/trpc/react";

type CalendarState = "with-events" | "no-events" | "no-calendar";

// TOOD: add calendar connection and sync logic

export function UpcomingEvents() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();

  // Switch this variable to test different states:
  // "with-events" - shows upcoming events
  // "no-events" - calendar connected but no events
  // "no-calendar" - no calendar connected
  const calendarState: CalendarState = "with-events";

  // TODO: replace mock data with actual data from backend
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const mockEvents: UpcomingEvent[] = [
    {
      id: "product-review-q3",
      title: "Product Review: Q3 Feature Planning",
      date: tomorrow,
      startTime: "2:00 PM",
      endTime: "3:00 PM",
      meetingUrl: "https://zoom.us/j/123456789",
      calendarColor: "#0A84FF",
    },
    {
      id: "1on1-sarah",
      title: "1:1 with Sarah - Engineering Sync",
      date: tomorrow,
      startTime: "10:00 AM",
      endTime: "10:30 AM",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      calendarColor: "#34C759",
    },
  ];

  // Determine events based on state
  const upcomingEvents = calendarState === "with-events" ? mockEvents : [];

  const createNoteFromEvent = api.notes.createNoteFromEvent.useMutation({
    onSuccess: (data) => {
      utils.notes.getNotes.invalidate();
      navigate({
        to: "/settings/notes/$noteId",
        params: { noteId: String(data.note.id) },
      });
    },
  });

  const handleTakeNotes = (event: UpcomingEvent) => {
    if (createNoteFromEvent.isPending) return;
    createNoteFromEvent.mutate({
      title: event.title,
      eventData: {
        eventId: event.id,
        title: event.title,
        calendarColor: event.calendarColor ?? "#0A84FF",
        meetingUrl: event.meetingUrl,
        calendarEventUrl: event.calendarEventUrl,
        startTime: event.startTime,
        endTime: event.endTime,
        date: event.date.toISOString(),
      },
    });
  };

  const handleConnectCalendar = () => {
    // Handle connecting calendar
    console.log("Connecting calendar...");
    // TODO: implement your calendar connection logic here
    // You can implement your calendar connection logic here
  };
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Calendar className="w-4 h-4" />
        <h2 className="text-sm font-medium">
          {t("settings.notes.upcomingEvents.title")}
        </h2>
      </div>

      {calendarState === "with-events" ? (
        <div className="bg-accent/40 rounded-xl overflow-clip">
          {upcomingEvents.map((event) => (
            <div key={event.id}>
              <UpcomingEventCard event={event} onTakeNotes={handleTakeNotes} />
            </div>
          ))}
        </div>
      ) : calendarState === "no-events" ? (
        <div className="border border-dashed rounded-lg p-6 text-center">
          <CalendarX className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {t("settings.notes.upcomingEvents.empty")}
          </p>
        </div>
      ) : (
        <div className="border border-dashed rounded-lg p-6 text-center space-y-4">
          <CalendarPlus className="w-8 h-8 text-muted-foreground mx-auto" />
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("settings.notes.upcomingEvents.connect.title")}
              <br />
              {t("settings.notes.upcomingEvents.connect.description")}
            </p>
            <Button
              onClick={handleConnectCalendar}
              className="mt-2"
              size={"sm"}
              variant={"outline"}
            >
              <CalendarPlus className="w-4 h-4" />
              {t("settings.notes.upcomingEvents.connect.button")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
