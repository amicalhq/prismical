import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import NotesService from "../../services/notes-service";
import { ServiceManager } from "../../main/managers/service-manager";

const notesService = NotesService.getInstance();

const NoteEventDataSchema = z.object({
  eventId: z.string(),
  title: z.string(),
  calendarColor: z.string(),
  meetingUrl: z.string().optional(),
  calendarEventUrl: z.string().optional(),
  startAt: z.date(),
  endAt: z.date(),
  isAllDay: z.boolean().default(false),
});

// Input schemas
const GetNotesSchema = z.object({
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
  sortBy: z
    .enum(["title", "updatedAt", "createdAt"])
    .optional()
    .default("updatedAt"),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional(),
  transcriptionId: z.number().nullable().optional(),
  tagId: z.number().optional(),
  tagIds: z.array(z.number()).optional(),
  folderId: z.number().nullable().optional(),
  folderIds: z.array(z.number()).optional(),
});

const CreateNoteSchema = z.object({
  title: z.string().min(1),
  icon: z.string().nullish(),
});

const UpdateNoteTitleSchema = z.object({
  id: z.number(),
  title: z.string().min(1),
});

const UpdateNoteIconSchema = z.object({
  id: z.number(),
  icon: z.string().nullish(),
});

const UpdateNoteOrganizationSchema = z
  .object({
    id: z.number(),
    starred: z.boolean().optional(),
    folderId: z.number().int().nullable().optional(),
  })
  .refine(
    (input) => input.starred !== undefined || input.folderId !== undefined,
    {
      message: "At least one organization field must be provided",
    },
  );

export const notesRouter = createRouter({
  // Get all notes
  getNotes: procedure.input(GetNotesSchema).query(async ({ input }) => {
    return await notesService.listNotes({
      limit: input.limit,
      offset: input.offset,
      sortBy: input.sortBy,
      sortOrder: input.sortOrder,
      search: input.search,
      transcriptionId: input.transcriptionId,
      tagId: input.tagId,
      tagIds: input.tagIds,
      folderId: input.folderId,
      folderIds: input.folderIds,
    });
  }),

  // Get note by ID
  getNoteById: procedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const note = await notesService.getNote(input.id);
      if (!note) {
        throw new Error("Note not found");
      }
      return note;
    }),

  // Create new note
  createNote: procedure.input(CreateNoteSchema).mutation(async ({ input }) => {
    const note = await notesService.createNote({
      title: input.title,
      icon: input.icon,
    });

    // Track telemetry
    const telemetryService =
      ServiceManager.getInstance().getService("telemetryService");
    telemetryService.trackNoteCreated({
      note_id: note.id,
      has_initial_content: false,
      has_icon: !!input.icon,
    });

    return note;
  }),

  // Create or find a note linked to a calendar event (idempotent)
  createNoteFromEvent: procedure
    .input(
      z.object({
        eventData: NoteEventDataSchema,
        title: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      // Upsert the event into the events table
      await notesService.ensureEvent({
        id: input.eventData.eventId,
        title: input.eventData.title,
        calendarColor: input.eventData.calendarColor,
        meetingUrl: input.eventData.meetingUrl ?? null,
        calendarEventUrl: input.eventData.calendarEventUrl ?? null,
        startAt: input.eventData.startAt,
        endAt: input.eventData.endAt,
        isAllDay: input.eventData.isAllDay,
      });

      // Check if a note already exists for this event
      const existing = await notesService.findNoteByEventId(
        input.eventData.eventId,
      );
      if (existing) {
        return { note: existing, created: false };
      }

      // Create a new note linked to the event.
      // Try/catch handles the race where a concurrent request creates
      // the note between findNoteByEventId and createNote — the unique
      // constraint on event_id will reject the duplicate.
      try {
        const note = await notesService.createNote({
          title: input.title,
          eventId: input.eventData.eventId,
        });

        // Track telemetry
        const telemetryService =
          ServiceManager.getInstance().getService("telemetryService");
        telemetryService.trackNoteCreated({
          note_id: note.id,
          has_initial_content: false,
          has_icon: false,
        });

        return { note, created: true };
      } catch {
        // Unique constraint violation — note was created by concurrent request
        const concurrent = await notesService.findNoteByEventId(
          input.eventData.eventId,
        );
        if (concurrent) {
          return { note: concurrent, created: false };
        }
        throw new Error("Failed to create note for event");
      }
    }),

  // Update note title
  updateNoteTitle: procedure
    .input(UpdateNoteTitleSchema)
    .mutation(async ({ input }) => {
      const updated = await notesService.updateNote(input.id, {
        title: input.title,
      });
      if (!updated) {
        throw new Error("Failed to update note");
      }
      return updated;
    }),

  updateNoteIcon: procedure
    .input(UpdateNoteIconSchema)
    .mutation(async ({ input }) => {
      const updated = await notesService.updateNote(input.id, {
        icon: input.icon,
      });
      if (!updated) {
        throw new Error("Failed to update note");
      }
      return updated;
    }),

  updateNoteOrganization: procedure
    .input(UpdateNoteOrganizationSchema)
    .mutation(async ({ input }) => {
      const updated = await notesService.updateNote(input.id, {
        starred: input.starred,
        folderId: input.folderId,
      });
      if (!updated) {
        throw new Error("Failed to update note organization");
      }
      return updated;
    }),

  // Delete note
  deleteNote: procedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const deleted = await notesService.deleteNote(input.id);
      if (!deleted) {
        throw new Error("Note not found");
      }
      return { success: true };
    }),

  // Search notes (for command palette)
  searchNotes: procedure
    .input(
      z.object({
        query: z.string().optional().default(""),
        limit: z.number().optional().default(10),
      }),
    )
    .query(async ({ input }) => {
      const notes = await notesService.listNotes({
        search: input.query || "",
        limit: input.limit,
      });
      return notes.map((note) => ({
        id: note.id,
        title: note.title,
        createdAt: note.createdAt,
        icon: note.icon ?? null,
      }));
    }),

  // Hydrate a list of note IDs for the command palette's recents.
  // Order is not preserved; the client reorders to match the recents list.
  getNotesByIds: procedure
    .input(z.object({ ids: z.array(z.number().int()) }))
    .query(async ({ input }) => {
      const notes = await notesService.getNotesByIds(input.ids);
      return notes.map((note) => ({
        id: note.id,
        title: note.title,
        createdAt: note.createdAt,
        icon: note.icon ?? null,
      }));
    }),

});
