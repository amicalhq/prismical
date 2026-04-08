import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/trpc/react";
import type {
  MeetingRuntimeSnapshot,
  MeetingRuntimeState,
} from "@/types/meeting";

const EMPTY_MEETING_SNAPSHOT: MeetingRuntimeSnapshot = {
  state: "idle",
  mode: null,
  meetingId: null,
  noteId: null,
  durationMs: 0,
  startedAt: null,
};

function getStatusLabelKey(state: MeetingRuntimeState): string {
  switch (state) {
    case "starting":
      return "settings.notes.recordingBanner.status.starting";
    case "recording":
      return "settings.notes.recordingBanner.status.recording";
    case "stopping":
      return "settings.notes.recordingBanner.status.stopping";
    case "error":
      return "settings.notes.recordingBanner.status.error";
    case "idle":
      return "";
  }
}

function getMessageKey(state: MeetingRuntimeState): string {
  switch (state) {
    case "starting":
      return "settings.notes.recordingBanner.message.starting";
    case "recording":
      return "settings.notes.recordingBanner.message.recording";
    case "stopping":
      return "settings.notes.recordingBanner.message.stopping";
    case "error":
      return "settings.notes.recordingBanner.message.error";
    case "idle":
      return "";
  }
}

function MeetingRecordingStatusIcon({ state }: { state: MeetingRuntimeState }) {
  if (state === "starting" || state === "stopping") {
    return <Loader2 className="h-4 w-4 animate-spin text-foreground/70" />;
  }

  if (state === "error") {
    return <AlertTriangle className="h-4 w-4 text-destructive" />;
  }

  return (
    <span className="relative flex h-4 w-4 items-center justify-center">
      <span className="absolute h-3 w-3 animate-ping rounded-full bg-red-500/35" />
      <span className="relative h-2.5 w-2.5 rounded-full bg-red-500" />
    </span>
  );
}

export function MeetingRecordingBanner() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [meetingSnapshot, setMeetingSnapshot] =
    useState<MeetingRuntimeSnapshot>(EMPTY_MEETING_SNAPSHOT);

  api.meetings.stateUpdates.useSubscription(undefined, {
    onData: (snapshot) => {
      setMeetingSnapshot(snapshot);
    },
    onError: (error) => {
      console.error("Failed to subscribe to meeting state:", error);
    },
  });

  const activeNoteId = meetingSnapshot.noteId;
  const shouldShow =
    activeNoteId !== null &&
    meetingSnapshot.state !== "idle" &&
    location.pathname !== `/settings/notes/${activeNoteId}`;

  const { data: activeNote } = api.notes.getNoteById.useQuery(
    { id: activeNoteId ?? 0 },
    {
      enabled: shouldShow && activeNoteId !== null,
    },
  );

  if (!shouldShow || activeNoteId === null) {
    return null;
  }

  const noteTitle =
    activeNote?.title?.trim() || t("settings.notes.untitledTitle");
  const statusLabelKey = getStatusLabelKey(meetingSnapshot.state);
  const messageKey = getMessageKey(meetingSnapshot.state);

  return (
    <div className="shrink-0 border-b border-border/70 bg-background/95">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-border/70 bg-muted/35 px-3 py-2 shadow-xs">
          <MeetingRecordingStatusIcon state={meetingSnapshot.state} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
                  meetingSnapshot.state === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-foreground/6 text-foreground/70",
                )}
              >
                {t(statusLabelKey)}
              </span>
              <p className="min-w-0 truncate text-sm font-medium text-foreground/90">
                {t(messageKey, { title: noteTitle })}
              </p>
            </div>
          </div>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() =>
            navigate({
              to: "/settings/notes/$noteId",
              params: { noteId: String(activeNoteId) },
            })
          }
        >
          {t("settings.notes.recordingBanner.returnToNote")}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
