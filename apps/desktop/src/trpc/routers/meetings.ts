import { dialog } from "electron";
import { observable } from "@trpc/server/observable";
import * as fs from "node:fs";
import { z } from "zod";
import {
  deleteMeeting,
  getMeetingById,
  getMeetings,
  getNoteTranscript,
} from "@/db/meetings";
import type {
  MeetingLevels,
  MeetingRuntimeSnapshot,
  TranscriptEvent,
} from "@/types/meeting";
import { createRouter, procedure } from "../trpc";

const StartMeetingSchema = z.object({
  noteId: z.number().int().positive(),
  mode: z.enum(["mic", "system", "dual"]).default("dual"),
});

const ExportMeetingSchema = z.object({
  id: z.string(),
  format: z.enum(["txt", "json", "srt"]),
});

export const meetingsRouter = createRouter({
  startMeeting: procedure
    .input(StartMeetingSchema)
    .mutation(async ({ ctx, input }) => {
      const meetingManager = ctx.serviceManager.getService("meetingManager");
      return await meetingManager.start(input.noteId, input.mode);
    }),

  stopMeeting: procedure.mutation(async ({ ctx }) => {
    const meetingManager = ctx.serviceManager.getService("meetingManager");
    return await meetingManager.stop();
  }),

  getMeetingState: procedure.query(({ ctx }) => {
    const meetingManager = ctx.serviceManager.getService("meetingManager");
    return meetingManager.getState();
  }),

  getMeetings: procedure
    .input(
      z.object({
        limit: z.number().optional(),
        offset: z.number().optional(),
        noteId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input }) => {
      return await getMeetings(input);
    }),

  getNoteTranscript: procedure
    .input(z.object({ noteId: z.number().int().positive() }))
    .query(async ({ input }) => {
      return await getNoteTranscript(input.noteId);
    }),

  getMeetingById: procedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return await getMeetingById(input.id);
    }),

  deleteMeeting: procedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const meeting = await getMeetingById(input.id);
      const deleted = await deleteMeeting(input.id);

      if (meeting) {
        for (const artifact of meeting.artifacts) {
          try {
            await fs.promises.rm(artifact.path, { force: true });
          } catch (error) {
            ctx.serviceManager
              .getLogger()
              .main.warn("Failed to remove meeting artifact", {
                meetingId: input.id,
                path: artifact.path,
                error,
              });
          }
        }
      }

      return deleted;
    }),

  exportMeeting: procedure
    .input(ExportMeetingSchema)
    .mutation(async ({ input }) => {
      const meeting = await getMeetingById(input.id);
      if (!meeting) {
        throw new Error("Meeting not found.");
      }

      const defaultPath = `${sanitizeFilename(meeting.title)}.${input.format}`;
      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [
          {
            name:
              input.format === "json"
                ? "JSON"
                : input.format === "srt"
                  ? "SubRip"
                  : "Text",
            extensions: [input.format],
          },
        ],
      });

      if (result.canceled || !result.filePath) {
        return {
          canceled: true,
        };
      }

      const content =
        input.format === "json"
          ? JSON.stringify(meeting, null, 2)
          : input.format === "srt"
            ? toSrt(meeting.transcript)
            : toText(meeting.transcript);

      await fs.promises.writeFile(result.filePath, content, "utf8");
      return {
        canceled: false,
        filePath: result.filePath,
      };
    }),

  // eslint-disable-next-line deprecation/deprecation
  stateUpdates: procedure.subscription(({ ctx }) => {
    return observable<MeetingRuntimeSnapshot>((emit) => {
      const meetingManager = ctx.serviceManager.getService("meetingManager");
      const handleStateChange = (snapshot: MeetingRuntimeSnapshot) => {
        emit.next(snapshot);
      };

      emit.next(meetingManager.getState());
      meetingManager.on("state-changed", handleStateChange);

      return () => {
        meetingManager.off("state-changed", handleStateChange);
      };
    });
  }),

  // Per-source mic/system amplitude levels for waveform visualisation.
  // Throttled to ~30Hz on the main side — native frames arrive at 50-100Hz
  // and the visual difference of dropping every other one is imperceptible.
  // eslint-disable-next-line deprecation/deprecation
  levelUpdates: procedure.subscription(({ ctx }) => {
    return observable<MeetingLevels>((emit) => {
      const meetingManager = ctx.serviceManager.getService("meetingManager");
      const THROTTLE_MS = 33;
      let lastEmit = 0;

      const handleLevel = (levels: { mic?: number; system?: number }) => {
        const now = Date.now();
        if (now - lastEmit < THROTTLE_MS) return;
        lastEmit = now;
        emit.next({ mic: levels.mic ?? 0, system: levels.system ?? 0 });
      };

      // Seed an initial zeroed level so consumers don't have to special-case
      // the pre-first-frame moment.
      emit.next({ mic: 0, system: 0 });
      meetingManager.on("level", handleLevel);
      return () => {
        meetingManager.off("level", handleLevel);
      };
    });
  }),

  // eslint-disable-next-line deprecation/deprecation
  transcriptUpdates: procedure.subscription(({ ctx }) => {
    return observable<TranscriptEvent>((emit) => {
      const meetingManager = ctx.serviceManager.getService("meetingManager");
      const handleTranscriptEvent = (event: TranscriptEvent) => {
        emit.next(event);
      };

      meetingManager.on("transcript-event", handleTranscriptEvent);
      return () => {
        meetingManager.off("transcript-event", handleTranscriptEvent);
      };
    });
  }),
});

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
}

function toText(events: TranscriptEvent[]): string {
  return events
    .map(
      (event) =>
        `[${event.speaker === "you" ? "You" : "Them"} ${formatTimestamp(event.startTimeMs)}]\n${event.text}`,
    )
    .join("\n\n");
}

function toSrt(events: TranscriptEvent[]): string {
  return events
    .map((event, index) => {
      return [
        String(index + 1),
        `${formatSrtTimestamp(event.startTimeMs)} --> ${formatSrtTimestamp(event.endTimeMs)}`,
        `${event.speaker === "you" ? "You" : "Them"}: ${event.text}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatTimestamp(timestampMs: number): string {
  const totalSeconds = Math.floor(timestampMs / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatSrtTimestamp(timestampMs: number): string {
  const hours = Math.floor(timestampMs / 3_600_000)
    .toString()
    .padStart(2, "0");
  const minutes = Math.floor((timestampMs % 3_600_000) / 60_000)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor((timestampMs % 60_000) / 1000)
    .toString()
    .padStart(2, "0");
  const milliseconds = Math.floor(timestampMs % 1000)
    .toString()
    .padStart(3, "0");
  return `${hours}:${minutes}:${seconds},${milliseconds}`;
}
