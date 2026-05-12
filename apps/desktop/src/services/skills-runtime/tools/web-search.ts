import { tool } from "ai";
import { z } from "zod";

export function createWebSearchTool() {
  return tool({
    description:
      "Search the web for recent information. Returns top results as JSON. May return an empty array if web search is not configured for this installation.",
    inputSchema: z.object({
      query: z.string().min(1),
      max_results: z.number().int().min(1).max(10).optional(),
    }),
    execute: async () => {
      // v1 stub: not configured. Future: dispatch to Brave / Exa / etc.
      return {
        results: [],
        note: "Web search is not configured in this installation. Continue without web results.",
      };
    },
  });
}
