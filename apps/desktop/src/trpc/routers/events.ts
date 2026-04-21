import { z } from "zod";
import { createRouter, procedure } from "../trpc";
import { getUpcomingEvents } from "../../db/events";

export const eventsRouter = createRouter({
  getUpcoming: procedure
    .input(z.object({ limit: z.number().int().positive().optional() }).optional())
    .query(async ({ input }) => {
      return await getUpcomingEvents(input?.limit);
    }),
});
