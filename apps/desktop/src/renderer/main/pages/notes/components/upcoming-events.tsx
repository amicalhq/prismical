import { Calendar } from "lucide-react";
import UpcomingEventCard from "./upcoming-event-card";
import { UpcomingEvent } from "../types";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/trpc/react";

export function UpcomingEvents() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = api.useUtils();

  const { data: eventRows } = api.events.getUpcoming.useQuery({ limit: 3 });

  const upcomingEvents: UpcomingEvent[] = (eventRows ?? [])
    .filter((event) => event.meetingUrl)
    .map((event) => ({
      id: event.id,
      title: event.title,
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      meetingUrl: event.meetingUrl as string,
      calendarEventUrl: event.calendarEventUrl ?? undefined,
      calendarColor: event.calendarColor,
    }));

  const createNoteFromEvent = api.notes.createNoteFromEvent.useMutation({
    onSuccess: (data) => {
      utils.notes.getNotes.invalidate();
      navigate({
        to: "/notes/$noteId",
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
        startAt: event.startAt,
        endAt: event.endAt,
        isAllDay: event.isAllDay,
      },
    });
  };

  if (upcomingEvents.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Calendar className="w-4 h-4" />
        <h2 className="text-sm font-medium">
          {t("settings.notes.upcomingEvents.title")}
        </h2>
      </div>

      <div className="bg-accent/40 rounded-xl overflow-clip">
        {upcomingEvents.map((event) => (
          <div key={event.id}>
            <UpcomingEventCard event={event} onTakeNotes={handleTakeNotes} />
          </div>
        ))}
      </div>
    </div>
  );
}
