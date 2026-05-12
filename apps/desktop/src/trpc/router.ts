import { z } from "zod";
import { vocabularyRouter } from "./routers/vocabulary";
import { transcriptionsRouter } from "./routers/transcriptions";
import { modelsRouter } from "./routers/models";
import { instancesRouter } from "./routers/instances";
import { settingsRouter } from "./routers/settings";
import { updaterRouter } from "./routers/updater";
import { recordingRouter } from "./routers/recording";
import { notesRouter } from "./routers/notes";
import { authRouter } from "./routers/auth";
import { onboardingRouter } from "./routers/onboarding";
import { featureFlagsRouter } from "./routers/feature-flags";
import { meetingsRouter } from "./routers/meetings";
import { meetingWidgetRouter } from "./routers/meeting-widget";
import { eventsRouter } from "./routers/events";
import { artifactsRouter } from "./routers/artifacts";
import { tagsRouter } from "./routers/tags";
import { foldersRouter } from "./routers/folders";
import { skillsRouter } from "./routers/skills";
import { skillRunsRouter } from "./routers/skill-runs";
import { createRouter, procedure } from "./trpc";

export const router = createRouter({
  // Test procedures
  greeting: procedure.input(z.object({ name: z.string() })).query((req) => {
    return {
      text: `Hello ${req.input.name}`,
      timestamp: new Date(), // Date objects require transformation
    };
  }),

  // Example of a simple procedure without input
  ping: procedure.query(() => {
    return {
      message: "pong",
      timestamp: new Date(),
    };
  }),

  // Example mutation
  echo: procedure.input(z.object({ message: z.string() })).mutation((req) => {
    return {
      echo: req.input.message,
      timestamp: new Date(),
    };
  }),

  // Vocabulary router
  vocabulary: vocabularyRouter,

  // Transcriptions router
  transcriptions: transcriptionsRouter,

  // Models router (whisper download manager + speech selection)
  models: modelsRouter,

  // Provider instances router (CRUD + catalog + per-use-case defaults)
  instances: instancesRouter,

  // Settings router
  settings: settingsRouter,

  // Auto-updater router
  updater: updaterRouter,

  // Recording router
  recording: recordingRouter,

  // Notes router
  notes: notesRouter,

  // Auth router
  auth: authRouter,

  // Onboarding router
  onboarding: onboardingRouter,

  // Feature flags router
  featureFlags: featureFlagsRouter,

  // Meetings router
  meetings: meetingsRouter,

  // Meeting recording widget router
  meetingWidget: meetingWidgetRouter,

  // Events router
  events: eventsRouter,

  // Note artifacts router
  artifacts: artifactsRouter,

  // Tags router
  tags: tagsRouter,

  // Folders router
  folders: foldersRouter,

  // Skills router (PRSM-2)
  skills: skillsRouter,

  // Skill runs router (PRSM-2 agent runtime)
  skillRuns: skillRunsRouter,
});

export type AppRouter = typeof router;
